import crypto from 'crypto';
import { projectRepository } from '../repositories/project.repository';
import { milestoneRepository } from '../repositories/milestone.repository';
import { auditRepository, notificationRepository, paymentRepository } from '../repositories/shared.repository';
import { milestoneService, PLATFORM_FEE_PERCENT } from './milestone.service';
import { NombaWebhookPayload } from '../types';

export class WebhookService {
  verifySignature(payload: string, signature: string, timestamp?: string): boolean {
    const secret = process.env.NOMBA_WEBHOOK_SECRET;
    if (!secret) return true; // Skip verification in dev if no secret set
    if (!signature || !timestamp) return false;

    let parsedPayload: NombaWebhookPayload;
    try {
      parsedPayload = JSON.parse(payload) as NombaWebhookPayload;
    } catch {
      return false;
    }

    const merchantUserId = parsedPayload.data?.merchant?.userId ?? '';
    const merchantWalletId = parsedPayload.data?.merchant?.walletId ?? '';
    const transaction = parsedPayload.data?.transaction ?? {
      transactionId: '',
      type: '',
      time: '',
      responseCode: '',
    };

    let responseCode = transaction.responseCode ?? '';
    if (responseCode === 'null') responseCode = '';

    const hashingPayload = `${parsedPayload.event_type}:${parsedPayload.requestId}:${merchantUserId}:${merchantWalletId}:${transaction.transactionId}:${transaction.type}:${transaction.time}:${responseCode}:${timestamp}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(hashingPayload).digest('base64');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, 'base64'),
        Buffer.from(expectedSig, 'base64')
      );
    } catch {
      return false;
    }
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

    const { transaction } = payload.data;
    const amount = transaction.transactionAmount;
    const accountNumber = transaction.aliasAccountNumber;

    if (amount === undefined) {
      console.warn('Inbound payment webhook missing transaction.transactionAmount — ignoring');
      return;
    }

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

  // Handles payout_success / payout_failed events — these are the
  // authoritative confirmation for transfers initiated via
  // POST /v2/transfers/bank that came back PENDING_BILLING/NEW (see
  // nomba.service.ts / milestone.service.ts). Without this, a payout that
  // Nomba later refunds would silently leave a milestone marked in-progress
  // forever (or, before this fix, would already have been marked PAID
  // prematurely).
  //
  // Correlates the webhook back to a milestone via `merchantTxRef`, which we
  // control and set to `MPAY-${milestoneId}` when initiating the transfer.
  async handlePayoutOutcome(payload: NombaWebhookPayload): Promise<void> {
    const eventId = payload.requestId;

    const alreadyProcessed = await paymentRepository.isEventProcessed(eventId);
    if (alreadyProcessed) {
      console.log(`Webhook event ${eventId} already processed — skipping`);
      return;
    }
    await paymentRepository.markEventProcessed(eventId);

    const merchantTxRef = payload.data?.transaction?.merchantTxRef ?? '';
    const MILESTONE_REF_PREFIX = 'MPAY-';

    if (!merchantTxRef.startsWith(MILESTONE_REF_PREFIX)) {
      console.warn(`Payout webhook merchantTxRef "${merchantTxRef}" doesn't match a known milestone reference — ignoring`);
      return;
    }

    const milestoneId = merchantTxRef.slice(MILESTONE_REF_PREFIX.length);
    const milestone = await milestoneRepository.findById(milestoneId);
    if (!milestone) {
      console.warn(`Payout webhook referenced unknown milestone ${milestoneId}`);
      return;
    }

    // Idempotent: if we already finalized this milestone (e.g. the
    // synchronous call already returned SUCCESS, or a duplicate webhook
    // delivery), there's nothing further to do.
    if (milestone.state === 'PAID') {
      console.log(`Milestone ${milestoneId} already marked PAID — ignoring duplicate payout webhook`);
      return;
    }

    const project = await projectRepository.findById(milestone.project_id);
    if (!project) {
      console.warn(`Payout webhook referenced milestone ${milestoneId} with no matching project`);
      return;
    }

    if (payload.event_type === 'payout_success') {
      const transactionId = payload.data.transaction.transactionId;
      const platformFee = milestone.amount * PLATFORM_FEE_PERCENT;
      const transferAmount = milestone.amount - platformFee;
      await milestoneService.finalizeMilestonePayment(
        project,
        milestone,
        transactionId,
        transferAmount,
        platformFee
      );
    } else if (payload.event_type === 'payout_failed') {
      const reason = payload.data.transaction.responseCode || 'Payout failed/refunded by Nomba';
      await milestoneService.handleTransferFailure(project, milestone, reason);
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
