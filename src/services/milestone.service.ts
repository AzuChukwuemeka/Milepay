import { milestoneRepository } from '../repositories/milestone.repository';
import { projectRepository } from '../repositories/project.repository';
import {auditRepository, notificationRepository, disputeRepository,} from '../repositories/shared.repository';
import { initiateTransfer } from './nomba.service';
import {NotFoundError, ForbiddenError, ConflictError, ValidationError, } from '../utils/response';
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
    data: {
      deliveryNote: string;
      deliveryFiles?: string[];
    }
  ): Promise<Milestone | null> {

    const project = await projectRepository.findById(projectId);

    if (!project) throw new NotFoundError('Project');
    if (project.provider_id !== providerId) throw new ForbiddenError();
    if (project.state !== 'ACTIVE') {
      throw new ConflictError('Project is not active');
    }


    const milestone =
      await milestoneRepository.findById(milestoneId);


    if (!milestone || milestone.project_id !== projectId) {
      throw new NotFoundError('Milestone');
    }


    if (
      !['IN_PROGRESS', 'REVISION_REQUESTED']
        .includes(milestone.state)
    ) {
      throw new ConflictError(
        `Cannot submit milestone in state: ${milestone.state}`
      );
    }


    if (!data.deliveryNote ||
        data.deliveryNote.trim().length < 50) {
      throw new ValidationError(
        'Delivery note must be at least 50 characters',
        'deliveryNote'
      );
    }


    await milestoneRepository.submitDelivery(
      milestoneId,
      {
        deliveryNote: data.deliveryNote,
        deliveryFiles: data.deliveryFiles ?? [],
      }
    );


    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'MILESTONE_SUBMITTED',
      actorId: providerId,
      actorRole: 'provider',
      metadata: {
        milestoneTitle: milestone.title,
      },
    });


    if (project.client_id) {

      await notificationRepository.create({
        userId: project.client_id,
        title: 'Milestone Submitted for Review',
        message:
          `"${milestone.title}" has been submitted. You have 72 hours to approve or request revision.`,
        type: 'MILESTONE_SUBMITTED',
        metadata: {
          projectId,
          milestoneId,
        },
      });

    }


    return milestoneRepository.findById(milestoneId);
  }



  async approveMilestone(
    projectId: string,
    milestoneId: string,
    clientId: string
  ): Promise<Milestone | null> {


    const project =
      await projectRepository.findById(projectId);


    if (!project) throw new NotFoundError('Project');

    if (project.client_id !== clientId) {
      throw new ForbiddenError();
    }


    const milestone =
      await milestoneRepository.findById(milestoneId);


    if (!milestone ||
        milestone.project_id !== projectId) {
      throw new NotFoundError('Milestone');
    }


    if (milestone.state !== 'SUBMITTED') {
      throw new ConflictError(
        `Cannot approve milestone in state: ${milestone.state}`
      );
    }


    await milestoneRepository
      .setApprovedPendingTransfer(milestoneId);



    await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'MILESTONE_APPROVED',
      actorId: clientId,
      actorRole: 'client',
      metadata: {
        milestoneTitle: milestone.title,
        amount: milestone.amount,
      },
    });



    await this.executeTransfer(
      projectId,
      milestoneId
    );


    return milestoneRepository.findById(milestoneId);
  }



  async executeTransfer(
    projectId: string,
    milestoneId: string
  ): Promise<void> {

    const milestone = await milestoneRepository.findById(milestoneId);

    if (!milestone) return;

    const project = await projectRepository.findById(projectId);

    if (!project) return;

    const providerResult = await pool.query(
      `
      SELECT 
        pp.bank_code,
        pp.account_number,
        pp.account_name,
        u.email,
        u.name
      FROM provider_profiles pp
      JOIN users u 
        ON u.id = pp.user_id
      WHERE pp.user_id = $1
      `,
      [project.provider_id]
    );

    const provider = providerResult.rows[0];

    if (!provider?.bank_code || !provider?.account_number) {
      console.error(`Provider ${project.provider_id} missing bank details`);
      return;
    }

    // KEEP PLATFORM FEE
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
        throw new Error(transfer.reason);
      }

      if (transfer.outcome === 'PENDING') {

      await milestoneRepository.setTransferRef(milestoneId, transfer.data.id);

      await auditRepository.log({
        projectId, 
        milestoneId,
        eventType: 'TRANSFER_PROCESSING',
          // FIX: prevent null actor fields
        actorId: project.client_id,
        actorRole: 'client',
        metadata: {
          transferRef: transfer.data.id,
          status: transfer.data.status,
          amount: transferAmount,
        },
      });

      await notificationRepository.create({
        userId: project.provider_id, 
        title: 'Payment Processing', 
        message: `Your payment of ₦${transferAmount.toLocaleString()} for "${milestone.title}" is being processed and will land shortly.`,
        type: 'MILESTONE_PAYMENT_PROCESSING',
        metadata: {
          projectId,
          milestoneId,
          amount: transferAmount,
        },
      });
        return;
      }

      await this.finalizeMilestonePayment(project, milestone, transfer.data.id, transferAmount, platformFee);
    } catch (error) {
      console.error(`Transfer attempt ${attempts} failed for milestone ${milestoneId}:`, error);

      await auditRepository.log({
      projectId,
      milestoneId,
      eventType: 'TRANSFER_FAILED',
      // FIX: prevent null actor fields
      actorId: project.client_id,
      actorRole: 'client',
      metadata: {
        attempt: attempts,
        error: String(error),
      },
    });

      if (attempts >= MAX_TRANSFER_ATTEMPTS) {
        await notificationRepository.create({
          userId: await this.getAdminId(),
          title: 'Transfer Failed - Manual Action Required',
          message: `Milestone "${milestone.title}" transfer failed after ${MAX_TRANSFER_ATTEMPTS} attempts.`,
          type: 'TRANSFER_FAILED_ADMIN',
          metadata: {
            projectId,
            milestoneId,
            attempts,
          },
        });



        await notificationRepository.create({
          userId: project.provider_id,
          title: 'Payment Delayed',
          message: `Your payment for "${milestone.title}" is temporarily delayed. Our team is resolving this.`,
          type: 'TRANSFER_DELAYED',
          metadata: {
            projectId,
            milestoneId,
          },
        });

      } else {

        await milestoneRepository.clearTransferRef(milestoneId);

        await milestoneRepository.updateState(milestoneId,'APPROVED_PENDING_TRANSFER');
      }
    }
  }


  async finalizeMilestonePayment(
    project: {
      id: string;
      title: string;
      provider_id: string;
    },

    milestone: {
      id: string;
      title: string;
      order_index: number;
    },

    transferRef: string,

    transferAmount: number,

    platformFee: number

  ): Promise<void> {


    const projectId = project.id;

    const milestoneId = milestone.id;



    await milestoneRepository.setPaid(
      milestoneId,
      transferRef
    );



    const nextMilestone = await milestoneRepository.findNextMilestone(
        projectId,
        milestone.order_index
      );



    if (nextMilestone) {


    await milestoneRepository.updateState(
      nextMilestone.id,
      'IN_PROGRESS'
    );
      
    await auditRepository.log({
      projectId,
      milestoneId: nextMilestone.id,
      eventType:'MILESTONE_UNLOCKED',
      metadata: {
          previousMilestoneId: milestoneId,
      },
    });

    } else {
    await projectRepository.updateState(
      projectId,
      'COMPLETED'
    );
      await auditRepository.log({

        projectId,

        eventType:
          'PROJECT_COMPLETED',

        metadata: {
          finalMilestoneId: milestoneId,
        },

      });

    }



    await notificationRepository.create({

      userId: project.provider_id,

      title: 'Milestone Payment Released',
      message: `₦${transferAmount.toLocaleString()} has been sent to your bank account for "${milestone.title}".`,
      type: 'MILESTONE_PAID',
      metadata: {
        projectId,
        milestoneId,
        amount: transferAmount,
      },

    });



    await auditRepository.log({

      projectId,

      milestoneId,

      eventType: 'TRANSFER_SUCCESSFUL',
      // FIX: prevent null actor fields
      actorId: project.provider_id,
      actorRole: 'provider',
      metadata: {
        transferRef,
        amount: transferAmount,
        fee: platformFee,
      },
    });



    const providerResult = await pool.query(
      `
      SELECT u.email, u.name
      FROM provider_profiles pp
      JOIN users u 
        ON u.id = pp.user_id
      WHERE pp.user_id = $1
      `,

      [project.provider_id]

    );



    const provider = providerResult.rows[0];



    if (provider?.email) {


      await sendEmail({

        to: provider.email,

        subject:
          `Payment Released: ${milestone.title}`,

        html:
          `<p>Hi ${provider.name},</p>
           <p>₦${transferAmount.toLocaleString()} has been released to your bank account for milestone:
           <strong>${milestone.title}</strong>.</p>`,

      });

    }

  }



  async handleTransferFailure(
    project: {
      id: string;
      title: string;
      provider_id: string;
    },

    milestone: {
      id: string;
      title: string;
      transfer_attempts: number;
    },

    reason: string

  ): Promise<void> {


    await auditRepository.log({

      projectId: project.id,

      milestoneId: milestone.id,

      eventType:
        'TRANSFER_FAILED',

      // webhook is system action
      actorRole: 'system',

      metadata: {

        attempt:
          milestone.transfer_attempts,

        error: reason,

        source:
          'payout_failed_webhook',

      },

    });



    if (
      milestone.transfer_attempts >=
      MAX_TRANSFER_ATTEMPTS
    ) {


      await notificationRepository.create({

        userId:
          await this.getAdminId(),

        title:
          'Transfer Failed - Manual Action Required',

        message:
          `Milestone "${milestone.title}" transfer failed after ${milestone.transfer_attempts} attempts: ${reason}`,

        type:
          'TRANSFER_FAILED_ADMIN',

        metadata: {
          projectId: project.id,
          milestoneId: milestone.id,
          attempts: milestone.transfer_attempts,
        },

      });


    } else {


      await milestoneRepository.clearTransferRef(
        milestone.id
      );


      await milestoneRepository.updateState(
        milestone.id,
        'APPROVED_PENDING_TRANSFER'
      );

    }

  }



  private async getAdminId(): Promise<string> {

    const result =
      await pool.query(
        `SELECT id FROM users WHERE role = 'admin' LIMIT 1`
      );


    return result.rows[0]?.id ?? '';

  }

}



export const milestoneService = new MilestoneService();