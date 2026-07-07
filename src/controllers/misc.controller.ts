import { Request, Response, NextFunction } from 'express';
import { webhookService } from '../services/webhook.service';
import { notificationRepository, disputeRepository, paymentRepository } from '../repositories/shared.repository';
import { userRepository } from '../repositories/user.repository';
import { milestoneService } from '../services/milestone.service';
import { uploadToCloudinary } from '../services/cloudinary.service';
import { sendSuccess, sendError } from '../utils/response';
import { resolveBankAccount, fetchBanks } from '../services/nomba.service';
import pool from '../config/database';

// ─── Nigerian Banks Lookup ────────────────────────────────────────────────────
const NIGERIAN_BANKS: Record<string, string> = {
  '044': 'Access Bank',
  '023': 'Citibank',
  '063': 'Diamond Bank',
  '050': 'EcoBank',
  '070': 'Fidelity Bank',
  '011': 'First Bank',
  '214': 'First City Monument Bank',
  '058': 'Guaranty Trust Bank',
  '030': 'Heritage Bank',
  '301': 'Jaiz Bank',
  '082': 'Keystone Bank',
  '526': 'Moniepoint',
  '014': 'MainStreet Bank',
  '076': 'Polaris Bank',
  '101': 'Providus Bank',
  '221': 'Stanbic IBTC',
  '068': 'Standard Chartered',
  '232': 'Sterling Bank',
  '100': 'Suntrust Bank',
  '032': 'Union Bank',
  '033': 'United Bank for Africa',
  '215': 'Unity Bank',
  '035': 'Wema Bank',
  '057': 'Zenith Bank',
  '120001': 'Opay',
  '120002': 'PalmPay',
  '090405': 'Nomba',
};

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
    const signature = (req.headers['nomba-signature'] || req.headers['x-nomba-signature']) as string;
    const timestamp = (req.headers['nomba-timestamp'] || req.headers['x-nomba-timestamp']) as string;
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);

    if (!webhookService.verifySignature(rawBody, signature, timestamp)) {
      sendError(res, 401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
      return;
    }

    res.status(200).json({ success: true, message: 'Webhook received' });
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
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [displayName, categories, bio, city, state]
 *             properties:
 *               displayName:
 *                 type: string
 *               categories:
 *                 type: string
 *                 description: Comma-separated list e.g. "Development,Design"
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
 *               profilePhoto:
 *                 type: string
 *                 format: binary
 *                 description: Profile photo (JPG/PNG, max 2MB)
 *               portfolioFile:
 *                 type: string
 *                 format: binary
 *                 description: Portfolio PDF or image (max 10MB)
 *     responses:
 *       200:
 *         description: Profile saved
 */
export const providerProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { displayName, categories, bio, portfolioUrl, city, state } = req.body;

    if (!displayName || !categories || !bio || !city || !state) {
      sendError(res, 400, 'VALIDATION_ERROR', 'All required fields must be provided');
      return;
    }

    const categoryArray = Array.isArray(categories)
      ? categories
      : categories.split(',').map((c: string) => c.trim());

    let profilePhotoUrl: string | null = null;
    let portfolioFileUrl: string | null = null;

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    if (files?.profilePhoto?.[0]) {
      profilePhotoUrl = await uploadToCloudinary(
        files.profilePhoto[0].buffer,
        'profile-photos',
        `${req.user!.userId}-profile`
      );
    }

    if (files?.portfolioFile?.[0]) {
      portfolioFileUrl = await uploadToCloudinary(
        files.portfolioFile[0].buffer,
        'portfolios',
        `${req.user!.userId}-portfolio`
      );
    }

    await pool.query(
      `UPDATE provider_profiles
       SET display_name=$1, categories=$2, bio=$3, portfolio_url=$4,
           profile_photo_url=$5, portfolio_file_url=$6, city=$7, state=$8, onboarding_step=1
       WHERE user_id=$9`,
      [displayName, categoryArray, bio, portfolioUrl ?? null, profilePhotoUrl, portfolioFileUrl, city, state, req.user!.userId]
    );

    sendSuccess(res, { step: 1 }, 'Profile saved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/provider/identity:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 2 — Provider identity verification (upload ID documents)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [idType, idNumber]
 *             properties:
 *               idType:
 *                 type: string
 *                 enum: [NIN, voters_card, passport, drivers_licence]
 *               idNumber:
 *                 type: string
 *               idFront:
 *                 type: string
 *                 format: binary
 *                 description: Front of ID document (JPG/PNG/PDF, max 5MB)
 *               idBack:
 *                 type: string
 *                 format: binary
 *                 description: Back of ID document (optional for passport)
 *               selfie:
 *                 type: string
 *                 format: binary
 *                 description: Selfie holding ID (optional)
 *     responses:
 *       200:
 *         description: Identity documents uploaded and submitted for review
 */
export const providerIdentity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { idType, idNumber } = req.body;

    if (!idType || !idNumber) {
      sendError(res, 400, 'VALIDATION_ERROR', 'ID type and number are required');
      return;
    }

    const validIdTypes = ['NIN','nin', 'voters_card', 'passport', 'drivers_licence'];
    if (!validIdTypes.includes(idType)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Invalid ID type. Must be NIN, voters_card, passport or drivers_licence', 'idType');
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    let idFrontUrl: string | null = null;
    let idBackUrl: string | null = null;
    let selfieUrl: string | null = null;

    if (files?.idFront?.[0]) {
      idFrontUrl = await uploadToCloudinary(
        files.idFront[0].buffer,
        'identity',
        `${req.user!.userId}-id-front`
      );
    }

    if (files?.idBack?.[0]) {
      idBackUrl = await uploadToCloudinary(
        files.idBack[0].buffer,
        'identity',
        `${req.user!.userId}-id-back`
      );
    }

    if (files?.selfie?.[0]) {
      selfieUrl = await uploadToCloudinary(
        files.selfie[0].buffer,
        'identity',
        `${req.user!.userId}-selfie`
      );
    }

    await pool.query(
      `UPDATE provider_profiles
       SET id_type=$1, id_number=$2, id_front_url=$3, id_back_url=$4, selfie_url=$5, onboarding_step=2
       WHERE user_id=$6`,
      [idType, idNumber, idFrontUrl, idBackUrl, selfieUrl, req.user!.userId]
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
 *                 example: "044"
 *               accountNumber:
 *                 type: string
 *                 example: "0123456789"
 *     responses:
 *       200:
 *         description: Returns resolved account name for provider to confirm
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accountName:
 *                   type: string
 *                 accountNumber:
 *                   type: string
 *                 bankCode:
 *                   type: string
 *                 bankName:
 *                   type: string
 */
export const providerBank = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bankCode, accountNumber } = req.body;
    if (!bankCode || !accountNumber) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Bank code and account number are required');
      return;
    }
    const resolved = await resolveBankAccount({ bankCode, accountNumber });
    const bankName = NIGERIAN_BANKS[bankCode] ?? bankCode;
    sendSuccess(res, { accountName: resolved.accountName, accountNumber, bankCode, bankName }, 'Account resolved');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /onboarding/provider/confirm:
 *   post:
 *     tags: [Onboarding]
 *     summary: Step 4 — Confirm bank details and accept terms to activate account
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
 *                 description: Must be true to activate account
 *     responses:
 *       200:
 *         description: Provider account activated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 onboardingComplete:
 *                   type: boolean
 *                   example: true
 */
export const providerConfirm = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bankCode, accountNumber, accountName, agreedToTerms } = req.body;

    if (!agreedToTerms) {
      sendError(res, 400, 'VALIDATION_ERROR', 'You must accept the terms to activate your account', 'agreedToTerms');
      return;
    }

    if (!bankCode || !accountNumber || !accountName) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Bank code, account number and account name are required');
      return;
    }

    // Use inline lookup — no DB query needed
    const bankName = NIGERIAN_BANKS[bankCode] ?? bankCode;

    await pool.query(
      `UPDATE provider_profiles
       SET bank_code=$1, bank_name=$2, account_number=$3, account_name=$4,
           terms_accepted=TRUE, terms_accepted_at=NOW(), onboarding_step=4
       WHERE user_id=$5`,
      [bankCode, bankName, accountNumber, accountName, req.user!.userId]
    );

    await userRepository.markOnboardingComplete(req.user!.userId);

    sendSuccess(res, { onboardingComplete: true }, 'Provider account activated successfully');
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
 *     summary: Step 2 — Client accepts terms to activate account
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
    if (!agreedToTerms) {
      sendError(res, 400, 'VALIDATION_ERROR', 'You must accept the terms');
      return;
    }
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
 * /banks/lookup:
 *   post:
 *     tags: [Onboarding]
 *     summary: Lookup/verify a bank account number via Nomba
 *     description: Resolves a bank account number to get the account holder's name. Used for verifying bank details before saving.
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
 *                 example: "044"
 *                 description: Bank code from GET /banks
 *               accountNumber:
 *                 type: string
 *                 example: "1938813553"
 *                 description: 10-digit NUBAN account number
 *     responses:
 *       200:
 *         description: Account resolved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     accountName:
 *                       type: string
 *                       example: "John Doe"
 *                     accountNumber:
 *                       type: string
 *                       example: "1938813553"
 *                     bankCode:
 *                       type: string
 *                       example: "044"
 *                     bankName:
 *                       type: string
 *                       example: "Access Bank"
 *       400:
 *         description: Missing bankCode or accountNumber
 *       500:
 *         description: Nomba lookup failed
 */
export const bankLookup = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { bankCode, accountNumber } = req.body;

    if (!bankCode || !accountNumber) {
      sendError(res, 400, 'VALIDATION_ERROR', 'bankCode and accountNumber are required');
      return;
    }

    if (accountNumber.length !== 10) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Account number must be 10 digits', 'accountNumber');
      return;
    }

    const resolved = await resolveBankAccount({ bankCode, accountNumber });
    const bankName = NIGERIAN_BANKS[bankCode] ?? bankCode;

    sendSuccess(res, {
      accountName: resolved.accountName,
      accountNumber,
      bankCode,
      bankName,
    }, 'Account resolved successfully');
  } catch (err) { next(err); }
};

/**
 * @swagger
 * /banks:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get list of Nigerian banks from Nomba (no auth required)
 *     responses:
 *       200:
 *         description: List of banks with code and name
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   code:
 *                     type: string
 *                     example: "058"
 *                   name:
 *                     type: string
 *                     example: "Guaranty Trust Bank"
 */
export const getBanks = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const banks = await fetchBanks();
    console.log('BANKS COUNT:', banks?.length, 'SAMPLE:', JSON.stringify(banks?.[0]));
    if (!banks || banks.length === 0) {
      // Fallback
      const fallback = Object.entries(NIGERIAN_BANKS).map(([code, name]) => ({ code, name }));
      sendSuccess(res, fallback);
      return;
    }
    sendSuccess(res, banks);
  } catch (err) {
    console.error('GET BANKS ERROR:', err);
    const fallback = Object.entries(NIGERIAN_BANKS).map(([code, name]) => ({ code, name }));
    sendSuccess(res, fallback);
  }
};

// ─── Provider Public Profile ──────────────────────────────────────────────────

/**
 * @swagger
 * /providers/{username}:
 *   get:
 *     tags: [Providers]
 *     summary: Get public provider profile with trust score and completion rate
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Public provider profile
 *       404:
 *         description: Provider not found
 */
export const getProviderProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { username } = req.params;

    const result = await pool.query(
      `SELECT
        u.id, u.name, u.created_at,
        pp.display_name, pp.categories, pp.bio, pp.portfolio_url,
        pp.profile_photo_url, pp.city, pp.state, pp.is_id_verified,
        pp.trust_score, pp.completed_projects
       FROM users u
       JOIN provider_profiles pp ON pp.user_id = u.id
       WHERE u.role = 'provider'
         AND (LOWER(pp.display_name) = LOWER($1) OR u.id::text = $1)`,
      [username]
    );

    if (!result.rows[0]) {
      sendError(res, 404, 'NOT_FOUND', 'Provider not found');
      return;
    }

    sendSuccess(res, result.rows[0]);
  } catch (err) { next(err); }
};

// ─── Provider Earnings ────────────────────────────────────────────────────────

/**
 * @swagger
 * /earnings:
 *   get:
 *     tags: [Providers]
 *     summary: Get provider earnings — paid milestones, pending amounts, bank details
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Provider earnings summary
 */
export const getProviderEarnings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    // Total paid out
    const paidResult = await pool.query(
      `SELECT COALESCE(SUM(m.amount * 0.98), 0) AS total_earned
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       WHERE p.provider_id = $1 AND m.state = 'PAID'`,
      [userId]
    );

    // Pending (approved but not yet transferred)
    const pendingResult = await pool.query(
      `SELECT COALESCE(SUM(m.amount * 0.98), 0) AS total_pending
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       WHERE p.provider_id = $1 AND m.state = 'APPROVED_PENDING_TRANSFER'`,
      [userId]
    );

    // Recent paid milestones
    const recentResult = await pool.query(
      `SELECT m.id, m.title, m.amount, m.amount * 0.98 AS amount_received,
              m.paid_at, m.nomba_transfer_ref, p.title AS project_title
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       WHERE p.provider_id = $1 AND m.state = 'PAID'
       ORDER BY m.paid_at DESC
       LIMIT 20`,
      [userId]
    );

    // Bank details
    const bankResult = await pool.query(
      `SELECT bank_name, account_number, account_name FROM provider_profiles WHERE user_id = $1`,
      [userId]
    );

    sendSuccess(res, {
      totalEarned: Number(paidResult.rows[0].total_earned),
      totalPending: Number(pendingResult.rows[0].total_pending),
      recentPayments: recentResult.rows,
      bankDetails: bankResult.rows[0] ?? null,
      platformFee: '2%',
    });
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
      await milestoneService.executeTransfer(dispute.project_id, dispute.milestone_id);
    }

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
 *     summary: Mark provider ID as verified — unlocks verified badge
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Provider verified badge unlocked
 */
export const adminVerifyUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await pool.query(
      `UPDATE provider_profiles SET is_id_verified = TRUE, trust_score = trust_score + 15 WHERE user_id = $1`,
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
