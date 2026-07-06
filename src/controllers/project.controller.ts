import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { projectService } from '../services/project.service';
import { milestoneService } from '../services/milestone.service';
import { paymentRepository } from '../repositories/shared.repository';
import { sendSuccess, sendError } from '../utils/response';

const milestoneSchema = z.object({
  title: z.string().min(2).max(100),
  description: z.string().min(10).max(500),
  deliverable: z.string().min(10).max(500),
  amount: z.number().positive(),
});

const createProjectSchema = z.object({
  title: z.string().min(2).max(255),
  description: z.string().min(10),
  clientEmail: z.string().email().optional(),
  totalAmount: z.number().positive(),
  currency: z.string().default('NGN'),
  milestones: z.array(milestoneSchema).min(1).max(10),
});

// ─── Project Controllers ──────────────────────────────────────────────────────

/**
 * @swagger
 * /projects:
 *   post:
 *     tags: [Projects]
 *     summary: Create a new project (provider only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, description, totalAmount, milestones]
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               clientEmail:
 *                 type: string
 *                 format: email
 *               totalAmount:
 *                 type: number
 *               currency:
 *                 type: string
 *                 default: NGN
 *               milestones:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     title:
 *                       type: string
 *                     description:
 *                       type: string
 *                     deliverable:
 *                       type: string
 *                     amount:
 *                       type: number
 *     responses:
 *       201:
 *         description: Project created with share URL
 *       400:
 *         description: Validation error
 */
export const createProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'VALIDATION_ERROR', parsed.error.errors[0].message);
      return;
    }
    const result = await projectService.createProject(req.user!.userId, parsed.data);
    sendSuccess(res, result, 'Project created successfully', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects:
 *   get:
 *     tags: [Projects]
 *     summary: List projects for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [provider, client]
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
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
 *         description: Paginated list of projects
 */
export const listProjects = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.listProjects(req.user!.userId, {
      role: req.query.role as 'provider' | 'client',
      state: req.query.state as string | undefined,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 20,
    } as Parameters<typeof projectService.listProjects>[1]);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/public:
 *   get:
 *     tags: [Projects]
 *     summary: Get public project preview (no auth required)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Public project details
 *       404:
 *         description: Project not found
 */
export const getPublicProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.getPublicProject(req.params.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}:
 *   get:
 *     tags: [Projects]
 *     summary: Get full project detail (authenticated parties only)
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
 *         description: Full project with milestones and audit log
 *       403:
 *         description: Not a party to this project
 *       404:
 *         description: Project not found
 */
export const getProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.getProject(req.params.id, req.user!.userId, req.user!.role);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/accept:
 *   post:
 *     tags: [Projects]
 *     summary: Client accepts project and triggers virtual account creation
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
 *         description: Returns Nomba virtual account number for payment
 *       409:
 *         description: Project not in acceptable state
 */
export const acceptProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.acceptProject(req.params.id, req.user!.userId);
    sendSuccess(res, result, 'Project accepted. Please fund the virtual account to begin.');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/cancel:
 *   post:
 *     tags: [Projects]
 *     summary: Cancel a project
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Project cancelled
 */
export const cancelProject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    await projectService.cancelProject(req.params.id, req.user!.userId, req.body.reason || '');
    sendSuccess(res, { success: true }, 'Project cancelled');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/audit:
 *   get:
 *     tags: [Projects]
 *     summary: Get full audit log for a project
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
 *         description: Timestamped audit events
 */
export const getAuditLog = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.getAuditLog(req.params.id, req.user!.userId, req.user!.role);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/payments:
 *   get:
 *     tags: [Payments]
 *     summary: Get all inbound payments for a project
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
 *         description: List of payments with reconciliation flags
 */
export const getProjectPayments = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const payments = await projectService.getProjectPayments(req.params.id, req.user!.userId, req.user!.role);
    sendSuccess(res, payments);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/payments/instructions:
 *   get:
 *     tags: [Payments]
 *     summary: Get payment instructions for a project
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
 *         description: Project payment instructions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 projectId:
 *                   type: string
 *                 title:
 *                   type: string
 *                 currency:
 *                   type: string
 *                 totalAmount:
 *                   type: number
 *                 amountPaid:
 *                   type: number
 *                 amountDue:
 *                   type: number
 *                 overpaymentAmount:
 *                   type: number
 *                 virtualAccount:
 *                   $ref: '#/components/schemas/VirtualAccount'
 *                 state:
 *                   type: string
 *                 shareUrl:
 *                   type: string
 *       403:
 *         description: Unauthorized to view this project
 *       404:
 *         description: Project not found or no payment instructions available
 */
export const getProjectPaymentInstructions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.getPaymentInstructions(req.params.id, req.user!.userId, req.user!.role);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/refund-overpayment:
 *   post:
 *     tags: [Payments]
 *     summary: Refund overpayment for a project
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
 *         description: Overpayment refund processed
 *       400:
 *         description: No overpayment available to refund
 *       403:
 *         description: Not authorized to refund this project
 *       404:
 *         description: Project not found
 */
export const refundOverpayment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await projectService.refundOverpayment(req.params.id, req.user!.userId, req.user!.role);
    sendSuccess(res, result, 'Overpayment refund processed');
  } catch (err) {
    next(err);
  }
};

// ─── Milestone Controllers ────────────────────────────────────────────────────

/**
 * @swagger
 * /projects/{id}/milestones/{mid}/submit:
 *   post:
 *     tags: [Milestones]
 *     summary: Provider submits a milestone
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: mid
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deliveryNote]
 *             properties:
 *               deliveryNote:
 *                 type: string
 *                 minLength: 50
 *               deliveryFiles:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Milestone submitted. Client has 72 hours to review.
 */
export const submitMilestone = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await milestoneService.submitMilestone(
      req.params.id,
      req.params.mid,
      req.user!.userId,
      req.body
    );
    sendSuccess(res, result, 'Milestone submitted for review');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/milestones/{mid}/approve:
 *   post:
 *     tags: [Milestones]
 *     summary: Client approves a milestone — triggers Nomba transfer
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Milestone approved. Transfer initiated to provider.
 */
export const approveMilestone = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await milestoneService.approveMilestone(req.params.id, req.params.mid, req.user!.userId);
    sendSuccess(res, result, 'Milestone approved. Payment transfer initiated.');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/milestones/{mid}/request-revision:
 *   post:
 *     tags: [Milestones]
 *     summary: Client requests revision on submitted milestone
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [notes]
 *             properties:
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Revision requested. Provider notified.
 */
export const requestRevision = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { notes } = req.body;
    if (!notes) { sendError(res, 400, 'VALIDATION_ERROR', 'Revision notes are required', 'notes'); return; }
    const result = await milestoneService.requestRevision(req.params.id, req.params.mid, req.user!.userId, notes);
    sendSuccess(res, result, 'Revision requested');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/milestones/{mid}/dispute:
 *   post:
 *     tags: [Milestones]
 *     summary: Client raises a dispute on a milestone
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason, description]
 *             properties:
 *               reason:
 *                 type: string
 *               description:
 *                 type: string
 *               evidenceFiles:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Dispute raised. Milestone funds frozen.
 */
export const disputeMilestone = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await milestoneService.disputeMilestone(req.params.id, req.params.mid, req.user!.userId, req.body);
    sendSuccess(res, result, 'Dispute raised. Funds are frozen pending admin review.');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/milestones/{mid}/counter-evidence:
 *   post:
 *     tags: [Milestones]
 *     summary: Provider submits counter-evidence on a dispute
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description:
 *                 type: string
 *               evidenceFiles:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Counter-evidence submitted
 */
export const submitCounterEvidence = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await milestoneService.submitCounterEvidence(req.params.id, req.params.mid, req.user!.userId, req.body);
    sendSuccess(res, result, 'Counter-evidence submitted');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /projects/{id}/milestones/{mid}:
 *   get:
 *     tags: [Milestones]
 *     summary: Get full milestone detail
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Milestone with all submissions and evidence
 */
export const getMilestone = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { milestoneRepository } = await import('../repositories/milestone.repository');
    const milestone = await milestoneRepository.findById(req.params.mid);
    if (!milestone) { sendError(res, 404, 'NOT_FOUND', 'Milestone not found'); return; }
    sendSuccess(res, milestone);
  } catch (err) {
    next(err);
  }
};
