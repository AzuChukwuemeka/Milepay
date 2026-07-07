import { milestoneRepository } from '../repositories/milestone.repository';
import { projectRepository } from '../repositories/project.repository';
import { auditRepository, notificationRepository, disputeRepository } from '../repositories/shared.repository';
import { initiateTransfer } from './nomba.service';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/response';
import { sendEmail } from './email.service';
import { Milestone, Dispute } from '../types';
import pool from '../config/database';

export const PLATFORM_FEE_PERCENT = 0.02; // 2%
const MAX_TRANSFER_ATTEMPTS = 3;

export class MilestoneService {
  async submitMilestone(
    projectId: string,
    milestoneId: string,
    providerId: string,
    data: { deliveryNote: string; deliveryFiles?: string[] }
  ): Promise<Milestone | null> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');
    if (project.provider_id !== providerId) throw new ForbiddenError();
    if (project.state !== 'ACTIVE') throw new ConflictError('Project is not active');

    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone || milestone.project_id !== projectId) throw new NotFoundError('Milestone');

    if (!['IN_PROGRESS', 'REVISION_REQUESTED'].includes(milestone.state)) {
      throw new ConflictError(`Cannot submit milestone in state: ${milestone.state}`);
    }

    if (!data.deliveryNote || data.deliveryNote.trim().length < 50) {
      throw new ValidationError('Delivery note must be at least 50 characters', 'deliveryNote');
    }

    await milestoneRepository.submitDelivery(milestoneId, {
      deliveryNote: data.deliveryNote,
      deliveryFiles: data.deliveryFiles ?? [],
    });

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'MILESTONE_SUBMITTED',
      actorId: providerId,
      actorRole: 'provider',
      metadata: { milestoneTitle: milestone.title },
    });

    if (project.client_id) {
      await notificationRepository.create({
        userId: project.client_id,
        title: 'Milestone Submitted for Review',
        message: `"${milestone.title}" has been submitted. You have 72 hours to approve or request revision.`,
        type: 'MILESTONE_SUBMITTED',
        metadata: { projectId, milestoneId },
      });
    }

    return milestoneRepository.findById(milestoneId);
  }

  async approveMilestone(
    projectId: string,
    milestoneId: string,
    clientId: string
  ): Promise<Milestone | null> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');
    if (project.client_id !== clientId) throw new ForbiddenError();

    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone || milestone.project_id !== projectId) throw new NotFoundError('Milestone');

    if (milestone.state !== 'SUBMITTED') {
      throw new ConflictError(`Cannot approve milestone in state: ${milestone.state}`);
    }

    await milestoneRepository.setApprovedPendingTransfer(milestoneId);

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'MILESTONE_APPROVED',
      actorId: clientId,
      actorRole: 'client',
      metadata: { milestoneTitle: milestone.title, amount: milestone.amount },
    });

    // Fire transfer
    await this.executeTransfer(projectId, milestoneId);

    return milestoneRepository.findById(milestoneId);
  }

  async executeTransfer(projectId: string, milestoneId: string): Promise<void> {
    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone) return;

    const project = await projectRepository.findById(projectId);
    if (!project) return;

    // Get provider bank details
    const providerResult = await pool.query(
      `SELECT pp.bank_code, pp.account_number, pp.account_name, u.email, u.name
       FROM provider_profiles pp
       JOIN users u ON u.id = pp.user_id
       WHERE pp.user_id = $1`,
      [project.provider_id]
    );

    const provider = providerResult.rows[0];
    if (!provider?.bank_code || !provider?.account_number) {
      console.error(`Provider ${project.provider_id} missing bank details for transfer`);
      return;
    }

    const platformFee = milestone.amount * PLATFORM_FEE_PERCENT;
    const transferAmount = milestone.amount - platformFee;

    const attempts = await milestoneRepository.incrementTransferAttempts(milestoneId);

    try {
      const transfer = await initiateTransfer({
        amount: transferAmount,
        bankCode: provider.bank_code,
        accountNumber: provider.account_number,
        accountName: provider.account_name,
        narration: `MilePay: ${project.title} - ${milestone.title}`,
        idempotencyKey: `MPAY-${milestoneId}`,
      });

      if (transfer.outcome === 'FAILED') {
        // Nomba responded, but rejected/refunded the transfer outright (e.g.
        // REFUND status, or a hard error). Treat exactly like a thrown error
        // so the existing retry/alert logic below runs.
        throw new Error(transfer.reason);
      }

      if (transfer.outcome === 'PENDING') {
        // Nomba accepted the request but hasn't confirmed the outcome yet
        // (data.status = PENDING_BILLING / NEW). This is NOT a success: do
        // NOT mark the milestone paid, unlock the next milestone, or tell the
        // provider money has landed. Persist the transfer id so (a) the retry
        // cron knows not to re-fire this (see findPendingTransfers), and (b)
        // we have it on hand for reconciliation. The payout_success /
        // payout_failed webhook (see webhook.service.ts) finalizes this.
        await milestoneRepository.setTransferRef(milestoneId, transfer.data.id);

        await auditRepository.log({
          projectId,
          milestoneId,
          eventType: 'TRANSFER_PROCESSING',
          metadata: { transferRef: transfer.data.id, status: transfer.data.status, amount: transferAmount },
        });

        await notificationRepository.create({
          userId: project.provider_id,
          title: 'Payment Processing',
          message: `Your payment of ₦${transferAmount.toLocaleString()} for "${milestone.title}" is being processed and will land shortly.`,
          type: 'MILESTONE_PAYMENT_PROCESSING',
          metadata: { projectId, milestoneId, amount: transferAmount },
        });

        return;
      }

      // outcome === 'SUCCESS'
      await this.finalizeMilestonePayment(project, milestone, transfer.data.id, transferAmount, platformFee);

    } catch (error) {
      console.error(`Transfer attempt ${attempts} failed for milestone ${milestoneId}:`, error);

      await auditRepository.log({
        projectId,
        milestoneId,
        eventType: 'TRANSFER_FAILED',
        metadata: { attempt: attempts, error: String(error) },
      });

      if (attempts >= MAX_TRANSFER_ATTEMPTS) {
        // Alert admin
        await notificationRepository.create({
          userId: await this.getAdminId(),
          title: 'Transfer Failed - Manual Action Required',
          message: `Milestone "${milestone.title}" transfer failed after ${MAX_TRANSFER_ATTEMPTS} attempts.`,
          type: 'TRANSFER_FAILED_ADMIN',
          metadata: { projectId, milestoneId, attempts },
        });

        await notificationRepository.create({
          userId: project.provider_id,
          title: 'Payment Delayed',
          message: `Your payment for "${milestone.title}" is temporarily delayed. Our team is resolving this.`,
          type: 'TRANSFER_DELAYED',
          metadata: { projectId, milestoneId },
        });
      } else {
        // Make sure there's no stale transfer ref blocking the retry cron
        // (findPendingTransfers only retries when nomba_transfer_ref IS NULL).
        await milestoneRepository.clearTransferRef(milestoneId);
        await milestoneRepository.updateState(milestoneId, 'APPROVED_PENDING_TRANSFER');
      }
    }
  }

  // Shared "the transfer is definitely done" path — called either immediately
  // (initiateTransfer returned outcome SUCCESS) or later, from the
  // payout_success webhook, once Nomba confirms a previously PENDING transfer
  // completed. Marks the milestone paid, unlocks the next milestone (or
  // completes the project), and notifies/emails the provider.
  async finalizeMilestonePayment(
    project: { id: string; title: string; provider_id: string },
    milestone: { id: string; title: string; order_index: number },
    transferRef: string,
    transferAmount: number,
    platformFee: number
  ): Promise<void> {
    const projectId = project.id;
    const milestoneId = milestone.id;

    await milestoneRepository.setPaid(milestoneId, transferRef);

    // Unlock next milestone
    const nextMilestone = await milestoneRepository.findNextMilestone(projectId, milestone.order_index);
    if (nextMilestone) {
      await milestoneRepository.updateState(nextMilestone.id, 'IN_PROGRESS');
      await auditRepository.log({
        projectId,
        milestoneId: nextMilestone.id,
        eventType: 'MILESTONE_UNLOCKED',
        metadata: { previousMilestoneId: milestoneId },
      });
    } else {
      // All milestones paid — complete project
      await projectRepository.updateState(projectId, 'COMPLETED');
      await auditRepository.log({
        projectId,
        eventType: 'PROJECT_COMPLETED',
        metadata: { finalMilestoneId: milestoneId },
      });
    }

    await notificationRepository.create({
      userId: project.provider_id,
      title: 'Milestone Payment Released',
      message: `₦${transferAmount.toLocaleString()} has been sent to your bank account for "${milestone.title}".`,
      type: 'MILESTONE_PAID',
      metadata: { projectId, milestoneId, amount: transferAmount },
    });

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'TRANSFER_SUCCESSFUL',
      metadata: { transferRef, amount: transferAmount, fee: platformFee },
    });

    const providerResult = await pool.query(
      `SELECT u.email, u.name FROM provider_profiles pp JOIN users u ON u.id = pp.user_id WHERE pp.user_id = $1`,
      [project.provider_id]
    );
    const provider = providerResult.rows[0];

    if (provider?.email) {
      await sendEmail({
        to: provider.email,
        subject: `Payment Released: ${milestone.title}`,
        html: `<p>Hi ${provider.name},</p><p>₦${transferAmount.toLocaleString()} has been released to your bank account for milestone: <strong>${milestone.title}</strong>.</p>`,
      });
    }
  }

  // Called from the payout_failed webhook when Nomba confirms a
  // previously-PENDING transfer was refunded/failed. Clears the stale
  // transfer ref (so the retry cron can safely pick it back up with the same
  // idempotency key) and alerts the admin/provider once attempts are
  // exhausted, mirroring the synchronous failure path above.
  async handleTransferFailure(
    project: { id: string; title: string; provider_id: string },
    milestone: { id: string; title: string; transfer_attempts: number },
    reason: string
  ): Promise<void> {
    const projectId = project.id;
    const milestoneId = milestone.id;

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'TRANSFER_FAILED',
      metadata: { attempt: milestone.transfer_attempts, error: reason, source: 'payout_failed_webhook' },
    });

    if (milestone.transfer_attempts >= MAX_TRANSFER_ATTEMPTS) {
      await notificationRepository.create({
        userId: await this.getAdminId(),
        title: 'Transfer Failed - Manual Action Required',
        message: `Milestone "${milestone.title}" transfer failed after ${milestone.transfer_attempts} attempts: ${reason}`,
        type: 'TRANSFER_FAILED_ADMIN',
        metadata: { projectId, milestoneId, attempts: milestone.transfer_attempts },
      });

      await notificationRepository.create({
        userId: project.provider_id,
        title: 'Payment Delayed',
        message: `Your payment for "${milestone.title}" is temporarily delayed. Our team is resolving this.`,
        type: 'TRANSFER_DELAYED',
        metadata: { projectId, milestoneId },
      });
    } else {
      await milestoneRepository.clearTransferRef(milestoneId);
      await milestoneRepository.updateState(milestoneId, 'APPROVED_PENDING_TRANSFER');
    }
  }

  async requestRevision(
    projectId: string,
    milestoneId: string,
    clientId: string,
    notes: string
  ): Promise<Milestone | null> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');
    if (project.client_id !== clientId) throw new ForbiddenError();

    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone || milestone.project_id !== projectId) throw new NotFoundError('Milestone');

    if (milestone.state !== 'SUBMITTED') {
      throw new ConflictError(`Cannot request revision on milestone in state: ${milestone.state}`);
    }

    await milestoneRepository.setRevisionRequested(milestoneId, notes);

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'REVISION_REQUESTED',
      actorId: clientId,
      actorRole: 'client',
      metadata: { notes },
    });

    await notificationRepository.create({
      userId: project.provider_id,
      title: 'Revision Requested',
      message: `Client requested revision on "${milestone.title}": ${notes}`,
      type: 'REVISION_REQUESTED',
      metadata: { projectId, milestoneId },
    });

    return milestoneRepository.findById(milestoneId);
  }

  async disputeMilestone(
    projectId: string,
    milestoneId: string,
    clientId: string,
    data: { reason: string; description: string; evidenceFiles?: string[] }
  ): Promise<Dispute> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');
    if (project.client_id !== clientId) throw new ForbiddenError();

    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone || milestone.project_id !== projectId) throw new NotFoundError('Milestone');

    if (!['SUBMITTED', 'APPROVED'].includes(milestone.state)) {
      throw new ConflictError(`Cannot dispute milestone in state: ${milestone.state}`);
    }

    await milestoneRepository.updateState(milestoneId, 'DISPUTED');

    const dispute = await disputeRepository.create({
      projectId,
      milestoneId,
      raisedBy: clientId,
      reason: data.reason,
      description: data.description,
      evidenceFiles: data.evidenceFiles ?? [],
    });

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'MILESTONE_DISPUTED',
      actorId: clientId,
      actorRole: 'client',
      metadata: { disputeId: dispute.id, reason: data.reason },
    });

    await notificationRepository.create({
      userId: project.provider_id,
      title: 'Milestone Disputed',
      message: `Client has raised a dispute on "${milestone.title}". Please submit counter-evidence.`,
      type: 'MILESTONE_DISPUTED',
      metadata: { projectId, milestoneId, disputeId: dispute.id },
    });

    return dispute;
  }

  async submitCounterEvidence(
    projectId: string,
    milestoneId: string,
    providerId: string,
    data: { description: string; evidenceFiles?: string[] }
  ): Promise<Dispute | null> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');
    if (project.provider_id !== providerId) throw new ForbiddenError();

    const dispute = await disputeRepository.findByMilestoneId(milestoneId);
    if (!dispute) throw new NotFoundError('Dispute');

    await disputeRepository.addCounterEvidence(dispute.id, data.description, data.evidenceFiles ?? []);

    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'COUNTER_EVIDENCE_SUBMITTED',
      actorId: providerId,
      actorRole: 'provider',
    });

    return disputeRepository.findById(dispute.id);
  }

  private async getAdminId(): Promise<string> {
    const result = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
    return result.rows[0]?.id ?? '';
  }
}

export const milestoneService = new MilestoneService();
