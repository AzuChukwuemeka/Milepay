import { Request, Response, NextFunction } from 'express';
import { webhookService } from '../services/webhook.service';
import { resolveBankAccount } from '../services/nomba.service';
import { notificationRepository, disputeRepository, paymentRepository } from '../repositories/shared.repository';
import { projectRepository } from '../repositories/project.repository';
import { userRepository } from '../repositories/user.repository';
import { milestoneService } from '../services/milestone.service';
import { initiateTransfer } from '../services/nomba.service';
import { sendSuccess, sendError } from '../utils/response';
import pool from '../config/database';

// ─── Webhook Controller ───────────────────────────────────────────────────────

/**
 * @swagger
 * /webhooks/nomba:
 *   post:
 *     tags: [Webhooks]
 *     summary: Nomba inbound payment webhook (called by Nomba, not frontend)
 *     description: Receives payment notifications from Nomba. Verifies HMAC signature and reconciles payment. Idempotent.
 *     responses:
 *       200:
 *         description: Webhook acknowledged
 */
export const nombaWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const signature = req.headers['x-nomba-signature'] as string;
    const rawBody = JSON.stringify(req.body);

    if (signature && !webhookService.verifySignature(rawBody, signature)) {
      sendError(res, 401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
      return;
    }

    // Always respond 200 fast — process async
    res.status(200).json({ success: true, message: 'Webhook received' });

    // Process after response
    await webhookService.handleInboundPayment(req.body);
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
};

// ─── Onboarding Controllers ───────────────────────────────────────────────────

/**
 * @swagger
 * /onboarding/provider/profile:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 1 — Provider profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [displayName, categories, bio, city, state]
 *             properties:
 *               displayName:
 *                 type: string
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *               bio:
 *                 type: string
 *                 minLength: 80
 *                 maxLength: 500
 *               portfolioUrl:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile saved
 */
export const providerProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { displayName, categories, bio, portfolioUrl, city, state } = req.body;
    if (!displayName || !categories?.length || !bio || !city || !state) {
      sendError(res, 400, 'VALIDATION_ERROR', 'All required fields must be provided');
      return;
    }
    await pool.query(
      `UPDATE provider_profiles SET display_name=$1, categories=$2, bio=$3, portfolio_url=$4, city=$5, state=$6, onboarding_step=1
       WHERE user_id=$7`,
      [displayName, categories, bio, portfolioUrl ?? null, city, state, req.user!.userId]
    );
    sendSuccess(res, { step: 1 }, 'Profile saved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/provider/identity:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 2 — Provider identity verification
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [idType, idNumber]
 *             properties:
 *               idType:
 *                 type: string
 *                 enum: [NIN, voters_card, passport, drivers_licence]
 *               idNumber:
 *                 type: string
 *               idFrontUrl:
 *                 type: string
 *               idBackUrl:
 *                 type: string
 *               selfieUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Identity documents saved for review
 */
export const providerIdentity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { idType, idNumber, idFrontUrl, idBackUrl, selfieUrl } = req.body;
    if (!idType || !idNumber) {
      sendError(res, 400, 'VALIDATION_ERROR', 'ID type and number are required');
      return;
    }
    await pool.query(
      `UPDATE provider_profiles SET id_type=$1, id_number=$2, id_front_url=$3, id_back_url=$4, selfie_url=$5, onboarding_step=2
       WHERE user_id=$6`,
      [idType, idNumber, idFrontUrl ?? null, idBackUrl ?? null, selfieUrl ?? null, req.user!.userId]
    );
    sendSuccess(res, { step: 2 }, 'Identity documents submitted for review');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/provider/bank:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 3 — Resolve provider bank account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankCode, accountNumber]
 *             properties:
 *               bankCode:
 *                 type: string
 *               accountNumber:
 *                 type: string
 *     responses:
 *       200:
 *         description: Returns resolved account name for confirmation
 */
export const providerBank = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bankCode, accountNumber } = req.body;
    if (!bankCode || !accountNumber) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Bank code and account number are required');
      return;
    }
    const resolved = await resolveBankAccount({ bankCode, accountNumber });
    sendSuccess(res, { accountName: resolved.accountName, accountNumber, bankCode }, 'Account resolved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/provider/confirm:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 4 — Confirm bank and accept terms
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankCode, accountNumber, accountName, agreedToTerms]
 *             properties:
 *               bankCode:
 *                 type: string
 *               accountNumber:
 *                 type: string
 *               accountName:
 *                 type: string
 *               agreedToTerms:
 *                 type: boolean
 *                 enum: [true]
 *     responses:
 *       200:
 *         description: Provider account activated
 */
export const providerConfirm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bankCode, accountNumber, accountName, agreedToTerms } = req.body;
    if (!agreedToTerms) { sendError(res, 400, 'VALIDATION_ERROR', 'You must accept the terms', 'agreedToTerms'); return; }
    const bankResult = await pool.query('SELECT bank_name FROM banks WHERE code = $1', [bankCode]);
    const bankName = bankResult.rows[0]?.bank_name ?? bankCode;
    await pool.query(
      `UPDATE provider_profiles SET bank_code=$1, bank_name=$2, account_number=$3, account_name=$4, terms_accepted=TRUE, terms_accepted_at=NOW(), onboarding_step=4
       WHERE user_id=$5`,
      [bankCode, bankName, accountNumber, accountName, req.user!.userId]
    );
    await userRepository.markOnboardingComplete(req.user!.userId);
    sendSuccess(res, { onboardingComplete: true }, 'Provider account activated');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/client/profile:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 1 — Client profile
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, phone, city, state]
 *             properties:
 *               fullName:
 *                 type: string
 *               phone:
 *                 type: string
 *               companyName:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *     responses:
 *       200:
 *         description: Client profile saved
 */
export const clientProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { fullName, phone, companyName, city, state } = req.body;
    if (!fullName || !phone || !city || !state) {
      sendError(res, 400, 'VALIDATION_ERROR', 'fullName, phone, city and state are required');
      return;
    }
    await pool.query(
      `UPDATE client_profiles SET full_name=$1, phone=$2, company_name=$3, city=$4, state=$5, onboarding_step=1 WHERE user_id=$6`,
      [fullName, phone, companyName ?? null, city, state, req.user!.userId]
    );
    sendSuccess(res, { step: 1 }, 'Profile saved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/client/confirm:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 2 — Client accepts terms
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [agreedToTerms]
 *             properties:
 *               agreedToTerms:
 *                 type: boolean
 *                 enum: [true]
 *     responses:
 *       200:
 *         description: Client account activated
 */
export const clientConfirm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { agreedToTerms } = req.body;
    if (!agreedToTerms) { sendError(res, 400, 'VALIDATION_ERROR', 'You must accept the terms'); return; }
    await pool.query(
      `UPDATE client_profiles SET terms_accepted=TRUE, terms_accepted_at=NOW(), onboarding_step=2 WHERE user_id=$1`,
      [req.user!.userId]
    );
    await userRepository.markOnboardingComplete(req.user!.userId);
    sendSuccess(res, { onboardingComplete: true }, 'Client account activated');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /banks:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get list of Nigerian banks (no auth required)
 *     responses:
 *       200:
 *         description: List of banks with code and name
 */
export const getBanks = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    // Nigerian banks list — in production, cache this or seed from Nomba
    const NIGERIAN_BANKS = [
      { code: '044', name: 'Access Bank' },
      { code: '023', name: 'Citibank' },
      { code: '063', name: 'Diamond Bank' },
      { code: '050', name: 'EcoBank' },
      { code: '070', name: 'Fidelity Bank' },
      { code: '011', name: 'First Bank' },
      { code: '214', name: 'First City Monument Bank' },
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '030', name: 'Heritage Bank' },
      { code: '301', name: 'Jaiz Bank' },
      { code: '082', name: 'Keystone Bank' },
      { code: '526', name: 'Moniepoint' },
      { code: '014', name: 'MainStreet Bank' },
      { code: '076', name: 'Polaris Bank' },
      { code: '101', name: 'Providus Bank' },
      { code: '221', name: 'Stanbic IBTC' },
      { code: '068', name: 'Standard Chartered' },
      { code: '232', name: 'Sterling Bank' },
      { code: '100', name: 'Suntrust Bank' },
      { code: '032', name: 'Union Bank' },
      { code: '033', name: 'United Bank for Africa' },
      { code: '215', name: 'Unity Bank' },
      { code: '035', name: 'Wema Bank' },
      { code: '057', name: 'Zenith Bank' },
      { code: '120001', name: 'Opay' },
      { code: '120002', name: 'PalmPay' },
      { code: '090405', name: 'Nomba' },
    ];
    sendSuccess(res, NIGERIAN_BANKS);
  } catch (err) { next(err); }
};

// ─── Notifications Controller ─────────────────────────────────────────────────

/**
 * @swagger
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Get user notifications
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: unread
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Paginated notifications
 */
export const getNotifications = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await notificationRepository.findByUserId(
      req.user!.userId,
      req.query.unread === 'true',
      Number(req.query.page) || 1,
      Number(req.query.limit) || 20
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
};

export const markNotificationRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await notificationRepository.markRead(req.params.id, req.user!.userId);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
};

export const markAllNotificationsRead = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await notificationRepository.markAllRead(req.user!.userId);
    sendSuccess(res, { success: true });
  } catch (err) { next(err); }
};

// ─── Admin Controllers ────────────────────────────────────────────────────────

/**
 * @swagger
 * /admin/disputes:
 *   get:
 *     tags: [Admin]
 *     summary: List all disputes (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: outcome
 *         schema:
 *           type: string
 *           enum: [PENDING, RELEASED_TO_PROVIDER, REFUNDED_TO_CLIENT]
 *     responses:
 *       200:
 *         description: Paginated disputes
 */
export const adminGetDisputes = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await disputeRepository.findAll({
      outcome: req.query.outcome as string,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/disputes/{id}/resolve:
 *   post:
 *     tags: [Admin]
 *     summary: Resolve a dispute — release to provider or refund to client
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [outcome, notes]
 *             properties:
 *               outcome:
 *                 type: string
 *                 enum: [release, refund]
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Dispute resolved. Transfer fired accordingly.
 */
export const adminResolveDispute = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { outcome, notes } = req.body;
    const dispute = await disputeRepository.findById(req.params.id);
    if (!dispute) { sendError(res, 404, 'NOT_FOUND', 'Dispute not found'); return; }

    const finalOutcome = outcome === 'release' ? 'RELEASED_TO_PROVIDER' : 'REFUNDED_TO_CLIENT';

    await disputeRepository.resolve(dispute.id, {
      outcome: finalOutcome,
      adminNotes: notes,
      resolvedBy: req.user!.userId,
    });

    if (outcome === 'release') {
      // Fire transfer to provider
      await milestoneService.executeTransfer(dispute.project_id, dispute.milestone_id);
    }
    // If refund — admin manually initiates via Nomba dashboard for MVP
    // TODO: implement automated refund transfer in Phase 2

    sendSuccess(res, { outcome: finalOutcome }, 'Dispute resolved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/unmatched-payments:
 *   get:
 *     tags: [Admin]
 *     summary: List unmatched/misdirected payments
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated unmatched payments
 */
export const adminGetUnmatched = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await paymentRepository.findUnmatched(
      Number(req.query.page) || 1,
      Number(req.query.limit) || 20
    );
    sendSuccess(res, result);
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/unmatched-payments/{id}/resolve:
 *   post:
 *     tags: [Admin]
 *     summary: Manually match an unmatched payment to a project
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               projectId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [match, return]
 *     responses:
 *       200:
 *         description: Payment resolved
 */
export const adminResolveUnmatched = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { projectId, action } = req.body;
    if (action === 'match' && projectId) {
      await paymentRepository.updateStatus(req.params.id, 'MATCHED', projectId);
    } else {
      await paymentRepository.updateStatus(req.params.id, 'REFUNDED');
    }
    sendSuccess(res, { success: true }, 'Payment resolved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/transactions:
 *   get:
 *     tags: [Admin]
 *     summary: All Nomba transactions across all projects
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated transactions
 */
export const adminGetTransactions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await paymentRepository.findAll({
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paginated users
 */
export const adminGetUsers = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await userRepository.findAll({
      role: req.query.role as string,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    });
    sendSuccess(res, result);
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/users/{id}/verify:
 *   post:
 *     tags: [Admin]
 *     summary: Mark provider ID as verified
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Provider verified badge unlocked
 */
export const adminVerifyUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await pool.query(
      `UPDATE provider_profiles SET is_id_verified = TRUE WHERE user_id = $1`,
      [req.params.id]
    );
    // Add trust score for verification
    await pool.query(
      `UPDATE provider_profiles SET trust_score = trust_score + 15 WHERE user_id = $1`,
      [req.params.id]
    );
    sendSuccess(res, { verified: true }, 'Provider verified');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /admin/users/{id}/suspend:
 *   post:
 *     tags: [Admin]
 *     summary: Suspend a user account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: User suspended
 */
export const adminSuspendUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { reason } = req.body;
    if (!reason) { sendError(res, 400, 'VALIDATION_ERROR', 'Suspension reason is required'); return; }
    await userRepository.suspend(req.params.id, reason);
    sendSuccess(res, { suspended: true }, 'User suspended');
  } catch (err) { next(err); }
};
