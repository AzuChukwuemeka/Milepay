import crypto from 'crypto';
import { projectRepository } from '../repositories/project.repository';
import { milestoneRepository } from '../repositories/milestone.repository';
import { auditRepository, notificationRepository, paymentRepository } from '../repositories/shared.repository';
import { NombaWebhookPayload } from '../types';

export class WebhookService {
  verifySignature(payload: string, signature: string): boolean {
    const secret = process.env.NOMBA_WEBHOOK_SECRET;
    if (!secret) return true; // Skip verification in dev if no secret set

    const expectedSig = crypto
      .createHmac('sha512', secret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  }

  async handleInboundPayment(payload: NombaWebhookPayload): Promise<void> {
    const eventId = payload.requestId;

    // Idempotency check
    const alreadyProcessed = await paymentRepository.isEventProcessed(eventId);
    if (alreadyProcessed) {
      console.log(`Webhook event ${eventId} already processed — skipping`);
      return;
    }

    await paymentRepository.markEventProcessed(eventId);

    const { transaction, virtualAccount } = payload.data;
    const amount = transaction.transactionAmount;
    const accountNumber = virtualAccount?.accountNumber;

    if (!accountNumber) {
      console.warn('Webhook missing virtualAccount.accountNumber');
      return;
    }

    // Find matching project by virtual account number
    const project = await projectRepository.findByVirtualAccountNumber(accountNumber);

    if (!project) {
      // Misdirected payment
      await paymentRepository.create({
        nombaTransactionId: transaction.transactionId,
        nombaEventId: eventId,
        amount,
        currency: 'NGN',
        status: 'UNMATCHED',
        rawPayload: payload as unknown as Record<string, unknown>,
      });

      console.warn(`Misdirected payment: account ${accountNumber} not matched to any project`);

      // Alert admin
      const { pool } = await import('../config/database');
      const adminResult = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
      const adminId = adminResult.rows[0]?.id;

      if (adminId) {
        await notificationRepository.create({
          userId: adminId,
          title: 'Unmatched Payment Received',
          message: `₦${amount.toLocaleString()} received on account ${accountNumber} — no matching project found.`,
          type: 'UNMATCHED_PAYMENT',
          metadata: { amount, accountNumber, transactionId: transaction.transactionId },
        });
      }
      return;
    }

    // Record the payment
    await paymentRepository.create({
      projectId: project.id,
      nombaTransactionId: transaction.transactionId,
      nombaEventId: eventId,
      amount,
      currency: 'NGN',
      status: 'MATCHED',
      rawPayload: payload as unknown as Record<string, unknown>,
    });

    const newAmountPaid = Number(project.amount_paid) + amount;
    const totalRequired = Number(project.total_amount);

    if (newAmountPaid < totalRequired) {
      // Underpayment
      const shortfall = totalRequired - newAmountPaid;
      const overpayment = 0;

      await projectRepository.updateAmountPaid(project.id, newAmountPaid, overpayment);
      await projectRepository.updateState(project.id, 'PARTIALLY_PAID');

      await auditRepository.log({
        projectId: project.id,
        eventType: 'PAYMENT_RECEIVED_UNDERPAYMENT',
        metadata: { amount, totalPaid: newAmountPaid, shortfall },
      });

      if (project.client_id) {
        await notificationRepository.create({
          userId: project.client_id,
          title: 'Payment Received — Top-up Required',
          message: `₦${amount.toLocaleString()} received. You still need to send ₦${shortfall.toLocaleString()} to the same account.`,
          type: 'UNDERPAYMENT',
          metadata: { projectId: project.id, shortfall, accountNumber },
        });
      }

    } else if (newAmountPaid > totalRequired) {
      // Overpayment
      const overpayment = newAmountPaid - totalRequired;

      await projectRepository.updateAmountPaid(project.id, totalRequired, overpayment);
      await projectRepository.updateState(project.id, 'ACTIVE');

      // Unlock first milestone
      await this.unlockFirstMilestone(project.id);

      await auditRepository.log({
        projectId: project.id,
        eventType: 'PAYMENT_RECEIVED_OVERPAYMENT',
        metadata: { amount, overpayment },
      });

      if (project.client_id) {
        await notificationRepository.create({
          userId: project.client_id,
          title: 'Project Funded — Overpayment Noted',
          message: `Your project is now active. You overpaid by ₦${overpayment.toLocaleString()} — this will be refunded at project close.`,
          type: 'OVERPAYMENT',
          metadata: { projectId: project.id, overpayment },
        });
      }

      await notificationRepository.create({
        userId: project.provider_id,
        title: 'Project Funded — Work Can Begin',
        message: `"${project.title}" has been fully funded. You can now start work on Milestone 1.`,
        type: 'PROJECT_FUNDED',
        metadata: { projectId: project.id },
      });

    } else {
      // Exact payment
      await projectRepository.updateAmountPaid(project.id, totalRequired, 0);
      await projectRepository.updateState(project.id, 'ACTIVE');

      await this.unlockFirstMilestone(project.id);

      await auditRepository.log({
        projectId: project.id,
        eventType: 'PAYMENT_RECEIVED_FULL',
        metadata: { amount },
      });

      if (project.client_id) {
        await notificationRepository.create({
          userId: project.client_id,
          title: 'Project Fully Funded',
          message: `Your project "${project.title}" is now active. Work will begin shortly.`,
          type: 'PROJECT_FUNDED',
          metadata: { projectId: project.id },
        });
      }

      await notificationRepository.create({
        userId: project.provider_id,
        title: 'Project Funded — Work Can Begin',
        message: `"${project.title}" has been fully funded. You can now start on Milestone 1.`,
        type: 'PROJECT_FUNDED',
        metadata: { projectId: project.id },
      });
    }
  }

  private async unlockFirstMilestone(projectId: string): Promise<void> {
    const firstMilestone = await milestoneRepository.findFirstMilestone(projectId);
    if (firstMilestone && firstMilestone.state === 'LOCKED') {
      await milestoneRepository.updateState(firstMilestone.id, 'IN_PROGRESS');
      await auditRepository.log({
        projectId,
        milestoneId: firstMilestone.id,
        eventType: 'MILESTONE_UNLOCKED',
        metadata: { reason: 'PROJECT_FUNDED' },
      });
    }
  }
}

export const webhookService = new WebhookService();
