import cron from 'node-cron';
import { milestoneRepository } from '../repositories/milestone.repository';
import { projectRepository } from '../repositories/project.repository';
import { auditRepository, notificationRepository } from '../repositories/shared.repository';
import { milestoneService } from '../services/milestone.service';

// ─── Auto-approve milestones after 72 hours ───────────────────────────────────
const autoApproveMilestones = async (): Promise<void> => {
  const milestones = await milestoneRepository.findSubmittedForAutoApproval();

  for (const milestone of milestones) {
    try {
      console.log(`Auto-approving milestone ${milestone.id}`);
      await milestoneRepository.setApprovedPendingTransfer(milestone.id);

      await auditRepository.log({
        projectId: milestone.project_id,
        milestoneId: milestone.id,
        eventType: 'MILESTONE_AUTO_APPROVED',
        metadata: { reason: '72_HOUR_TIMEOUT' },
      });

      const project = await projectRepository.findById(milestone.project_id);
      if (project?.client_id) {
        await notificationRepository.create({
          userId: project.client_id,
          title: 'Milestone Auto-Approved',
          message: `"${milestone.title}" was auto-approved after 72 hours. ₦${milestone.amount.toLocaleString()} released to provider.`,
          type: 'MILESTONE_AUTO_APPROVED',
          metadata: { projectId: milestone.project_id, milestoneId: milestone.id },
        });
      }

      await milestoneService.executeTransfer(milestone.project_id, milestone.id);
    } catch (err) {
      console.error(`Auto-approval failed for milestone ${milestone.id}:`, err);
    }
  }
};

// ─── Retry pending transfers ──────────────────────────────────────────────────
const retryPendingTransfers = async (): Promise<void> => {
  const milestones = await milestoneRepository.findPendingTransfers();

  for (const milestone of milestones) {
    if (milestone.transfer_attempts < 3) {
      try {
        console.log(`Retrying transfer for milestone ${milestone.id} (attempt ${milestone.transfer_attempts + 1})`);
        await milestoneService.executeTransfer(milestone.project_id, milestone.id);
      } catch (err) {
        console.error(`Transfer retry failed for milestone ${milestone.id}:`, err);
      }
    }
  }
};

// ─── Cancel timed-out projects (no payment after 7 days) ─────────────────────
const cancelTimedOutProjects = async (): Promise<void> => {
  const projects = await projectRepository.findTimedOutProjects();

  for (const project of projects) {
    try {
      await projectRepository.updateState(project.id, 'CANCELLED');
      await auditRepository.log({
        projectId: project.id,
        eventType: 'PROJECT_CANCELLED_TIMEOUT',
        metadata: { reason: 'No payment received within 7 days' },
      });

      if (project.provider_id) {
        await notificationRepository.create({
          userId: project.provider_id,
          title: 'Project Cancelled — Payment Timeout',
          message: `"${project.title}" was cancelled as no payment was received within 7 days.`,
          type: 'PROJECT_CANCELLED',
          metadata: { projectId: project.id },
        });
      }
    } catch (err) {
      console.error(`Timeout cancellation failed for project ${project.id}:`, err);
    }
  }
};

export const startCronJobs = (): void => {
  // Every 15 minutes — check for auto-approvals
  cron.schedule('*/15 * * * *', async () => {
    await autoApproveMilestones();
  });

  // Every 10 minutes — retry pending transfers
  cron.schedule('*/10 * * * *', async () => {
    await retryPendingTransfers();
  });

  // Every hour — cancel timed-out projects
  cron.schedule('0 * * * *', async () => {
    await cancelTimedOutProjects();
  });

  console.log('✅ Cron jobs started');
};
