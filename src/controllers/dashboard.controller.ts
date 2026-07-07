import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/response';
import pool from '../config/database';

// ─── Provider Dashboard ───────────────────────────────────────────────────────

/**
 * @swagger
 * /dashboard/provider:
 *   get:
 *     tags: [Dashboard]
 *     summary: Provider dashboard — active projects, pending milestones, earnings summary, recent activity
 *     description: No request body or query parameters are required. This endpoint only needs an Authorization header with a bearer token.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         description: Bearer token for the authenticated provider user.
 *         schema:
 *           type: string
 *           example: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwidXNlcklkIjoiZGVtbzEyMyIsInJvbGUiOiJwcm92aWRlciJ9.signature
 *     responses:
 *       200:
 *         description: Provider dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                   properties:
 *                     activeProjects:
 *                       type: integer
 *                     completedProjects:
 *                       type: integer
 *                     totalEarned:
 *                       type: number
 *                     pendingPayout:
 *                       type: number
 *                     trustScore:
 *                       type: integer
 *                     isVerified:
 *                       type: boolean
 *                 activeProjects:
 *                   type: array
 *                   description: Active projects with current milestone info
 *                 pendingMilestones:
 *                   type: array
 *                   description: Milestones awaiting client review
 *                 recentActivity:
 *                   type: array
 *                   description: Latest 10 audit events across all projects
 *                 unreadNotifications:
 *                   type: integer
 */
export const providerDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const statsResult = await pool.query(
      `SELECT
        COUNT(DISTINCT CASE WHEN p.state = 'ACTIVE' THEN p.id END) AS active_projects,
        COUNT(DISTINCT CASE WHEN p.state = 'COMPLETED' THEN p.id END) AS completed_projects,
        COALESCE(SUM(CASE WHEN m.state = 'PAID' THEN m.amount * 0.98 ELSE 0 END), 0) AS total_earned,
        COALESCE(SUM(CASE WHEN m.state = 'APPROVED_PENDING_TRANSFER' THEN m.amount * 0.98 ELSE 0 END), 0) AS pending_payout
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
       WHERE p.provider_id = $1`,
      [userId]
    );

    const profileResult = await pool.query(
      `SELECT trust_score, completed_projects, is_id_verified FROM provider_profiles WHERE user_id = $1`,
      [userId]
    );

    const activeProjectsResult = await pool.query(
      `SELECT
        p.id, p.title, p.total_amount, p.amount_paid, p.state,
        p.created_at, p.share_url,
        u.name AS client_name,
        (
          SELECT json_build_object(
            'id', m.id,
            'title', m.title,
            'amount', m.amount,
            'state', m.state,
            'auto_approve_at', m.auto_approve_at
          )
          FROM milestones m
          WHERE m.project_id = p.id
            AND m.state NOT IN ('LOCKED', 'PAID')
          ORDER BY m.order_index ASC
          LIMIT 1
        ) AS current_milestone,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS total_milestones,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.state = 'PAID') AS paid_milestones
       FROM projects p
       LEFT JOIN users u ON u.id = p.client_id
       WHERE p.provider_id = $1 AND p.state = 'ACTIVE'
       ORDER BY p.created_at DESC
       LIMIT 10`,
      [userId]
    );

    const pendingMilestonesResult = await pool.query(
      `SELECT
        m.id, m.title, m.amount, m.state, m.auto_approve_at, m.delivery_note,
        p.id AS project_id, p.title AS project_title,
        u.name AS client_name,
        EXTRACT(EPOCH FROM (m.auto_approve_at - NOW())) AS seconds_until_auto_approve
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       LEFT JOIN users u ON u.id = p.client_id
       WHERE p.provider_id = $1
         AND m.state IN ('SUBMITTED', 'REVISION_REQUESTED', 'APPROVED_PENDING_TRANSFER')
       ORDER BY m.auto_approve_at ASC NULLS LAST`,
      [userId]
    );

    const recentActivityResult = await pool.query(
      `SELECT ae.event_type, ae.metadata, ae.created_at, p.title AS project_title
       FROM audit_events ae
       JOIN projects p ON p.id = ae.project_id
       WHERE p.provider_id = $1
       ORDER BY ae.created_at DESC
       LIMIT 10`,
      [userId]
    );

    const notifResult = await pool.query(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    );

    const stats = statsResult.rows[0];
    const profile = profileResult.rows[0];

    sendSuccess(res, {
      stats: {
        activeProjects: Number(stats.active_projects),
        completedProjects: Number(stats.completed_projects),
        totalEarned: Number(stats.total_earned),
        pendingPayout: Number(stats.pending_payout),
        trustScore: profile?.trust_score ?? 0,
        isVerified: profile?.is_id_verified ?? false,
      },
      activeProjects: activeProjectsResult.rows,
      pendingMilestones: pendingMilestonesResult.rows,
      recentActivity: recentActivityResult.rows,
      unreadNotifications: Number(notifResult.rows[0].unread),
    });
  } catch (err) { next(err); }
};

// ─── Client Dashboard ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /dashboard/client:
 *   get:
 *     tags: [Dashboard]
 *     summary: Client dashboard — funded projects, pending approvals, history
 *     description: No request body or query parameters are required. This endpoint only needs an Authorization header with a bearer token.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         description: Bearer token for the authenticated client user.
 *         schema:
 *           type: string
 *           example: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwidXNlcklkIjoiZGVtbzEyMyIsInJvbGUiOiJjbGllbnQifQ.signature
 *     responses:
 *       200:
 *         description: Client dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                   properties:
 *                     activeProjects:
 *                       type: integer
 *                     completedProjects:
 *                       type: integer
 *                     totalSpent:
 *                       type: number
 *                     pendingApprovals:
 *                       type: integer
 *                 activeProjects:
 *                   type: array
 *                 pendingApprovals:
 *                   type: array
 *                   description: Milestones waiting for client to approve or dispute
 *                 recentActivity:
 *                   type: array
 *                 unreadNotifications:
 *                   type: integer
 */
export const clientDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user!.userId;

    const statsResult = await pool.query(
      `SELECT
        COUNT(DISTINCT CASE WHEN p.state = 'ACTIVE' THEN p.id END) AS active_projects,
        COUNT(DISTINCT CASE WHEN p.state = 'COMPLETED' THEN p.id END) AS completed_projects,
        COALESCE(SUM(CASE WHEN m.state = 'PAID' THEN m.amount ELSE 0 END), 0) AS total_spent,        
        COUNT(CASE WHEN m.state = 'SUBMITTED' THEN 1 END) AS pending_approvals
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
       WHERE p.client_id = $1`,
      [userId]
    );

    const activeProjectsResult = await pool.query(
      `SELECT
        p.id, p.title, p.total_amount, p.amount_paid, p.state,
        p.virtual_account_number, p.virtual_account_bank,
        p.created_at,
        u.name AS provider_name,
        pp.display_name AS provider_display_name,
        pp.profile_photo_url AS provider_photo,
        pp.trust_score, pp.is_id_verified,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id) AS total_milestones,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.state = 'PAID') AS paid_milestones,
        (SELECT COUNT(*) FROM milestones m WHERE m.project_id = p.id AND m.state = 'SUBMITTED') AS awaiting_approval
       FROM projects p
       JOIN users u ON u.id = p.provider_id
       LEFT JOIN provider_profiles pp ON pp.user_id = p.provider_id
       WHERE p.client_id = $1 AND p.state IN ('ACTIVE', 'PARTIALLY_PAID', 'PENDING_PAYMENT')
       ORDER BY p.created_at DESC
       LIMIT 10`,
      [userId]
    );

    const pendingApprovalsResult = await pool.query(
      `SELECT
        m.id, m.title, m.amount, m.state, m.delivery_note,
        m.delivery_files, m.auto_approve_at,
        p.id AS project_id, p.title AS project_title,
        u.name AS provider_name,
        EXTRACT(EPOCH FROM (m.auto_approve_at - NOW())) AS seconds_until_auto_approve
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       JOIN users u ON u.id = p.provider_id
       WHERE p.client_id = $1 AND m.state = 'SUBMITTED'
       ORDER BY m.auto_approve_at ASC NULLS LAST`,
      [userId]
    );

    const recentActivityResult = await pool.query(
      `SELECT ae.event_type, ae.metadata, ae.created_at, p.title AS project_title
       FROM audit_events ae
       JOIN projects p ON p.id = ae.project_id
       WHERE p.client_id = $1
       ORDER BY ae.created_at DESC
       LIMIT 10`,
      [userId]
    );

    const notifResult = await pool.query(
      `SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    );

    const stats = statsResult.rows[0];

    sendSuccess(res, {
      stats: {
        activeProjects: Number(stats.active_projects),
        completedProjects: Number(stats.completed_projects),
        totalSpent: Number(stats.total_spent),
        pendingApprovals: Number(stats.pending_approvals),
      },
      activeProjects: activeProjectsResult.rows,
      pendingApprovals: pendingApprovalsResult.rows,
      recentActivity: recentActivityResult.rows,
      unreadNotifications: Number(notifResult.rows[0].unread),
    });
  } catch (err) { next(err); }
};

// ─── Admin Dashboard ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /dashboard/admin:
 *   get:
 *     tags: [Dashboard]
 *     summary: Admin dashboard — platform overview, disputes, volume, stats
 *     description: No request body or query parameters are required. This endpoint only needs an Authorization header with a bearer token.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Authorization
 *         required: true
 *         description: Bearer token for the authenticated admin user.
 *         schema:
 *           type: string
 *           example: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwidXNlcklkIjoiYWRtaW4tZGVtbyIsInJvbGUiOiJhZG1pbiJ9.signature
 *     responses:
 *       200:
 *         description: Admin dashboard data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                     totalProviders:
 *                       type: integer
 *                     totalClients:
 *                       type: integer
 *                     activeProjects:
 *                       type: integer
 *                     completedProjects:
 *                       type: integer
 *                     openDisputes:
 *                       type: integer
 *                     unmatchedPayments:
 *                       type: integer
 *                     totalVolume:
 *                       type: number
 *                     platformRevenue:
 *                       type: number
 *                 recentDisputes:
 *                   type: array
 *                 recentUnmatched:
 *                   type: array
 *                 recentProjects:
 *                   type: array
 */
export const adminDashboard = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userStatsResult = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(CASE WHEN role = 'provider' THEN 1 END) AS total_providers,
        COUNT(CASE WHEN role = 'client' THEN 1 END) AS total_clients
       FROM users WHERE role != 'admin'`
    );

    const projectStatsResult = await pool.query(

        `SELECT
            COUNT(DISTINCT CASE WHEN p.state = 'ACTIVE' THEN p.id END) AS active_projects,
            COUNT(DISTINCT CASE WHEN p.state = 'COMPLETED' THEN p.id END) AS completed_projects,
            COALESCE(
                SUM(
                    CASE
                        WHEN m.state = 'PAID'
                        THEN m.amount
                        ELSE 0
                    END
                ),
                0
            ) AS total_volume
        FROM projects p
        LEFT JOIN milestones m
      ON m.project_id = p.id`
    );

    const disputeStatsResult = await pool.query(
      `SELECT COUNT(*) AS open_disputes FROM disputes WHERE outcome = 'PENDING'`
    );

    const unmatchedStatsResult = await pool.query(
      `SELECT COUNT(*) AS unmatched_payments FROM payments WHERE status = 'UNMATCHED'`
    );

    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(amount * 0.02), 0) AS platform_revenue
       FROM milestones WHERE state = 'PAID'`
    );

    const recentDisputesResult = await pool.query(
      `SELECT
        d.id, d.reason, d.outcome, d.created_at,
        p.title AS project_title,
        m.title AS milestone_title, m.amount,
        u.name AS raised_by_name
       FROM disputes d
       JOIN projects p ON p.id = d.project_id
       JOIN milestones m ON m.id = d.milestone_id
       JOIN users u ON u.id = d.raised_by
       WHERE d.outcome = 'PENDING'
       ORDER BY d.created_at DESC
       LIMIT 5`
    );

    const recentUnmatchedResult = await pool.query(
      `SELECT id, amount, currency, created_at, raw_payload
       FROM payments
       WHERE status = 'UNMATCHED'
       ORDER BY created_at DESC
       LIMIT 5`
    );

    const recentProjectsResult = await pool.query(
      `SELECT
        p.id, p.title, p.total_amount, p.state, p.created_at,
        pu.name AS provider_name,
        cu.name AS client_name
       FROM projects p
       JOIN users pu ON pu.id = p.provider_id
       LEFT JOIN users cu ON cu.id = p.client_id
       ORDER BY p.created_at DESC
       LIMIT 10`
    );

    const userStats = userStatsResult.rows[0];
    const projectStats = projectStatsResult.rows[0];

    sendSuccess(res, {
      stats: {
        totalUsers: Number(userStats.total_users),
        totalProviders: Number(userStats.total_providers),
        totalClients: Number(userStats.total_clients),
        activeProjects: Number(projectStats.active_projects),
        completedProjects: Number(projectStats.completed_projects),
        openDisputes: Number(disputeStatsResult.rows[0].open_disputes),
        unmatchedPayments: Number(unmatchedStatsResult.rows[0].unmatched_payments),
        totalVolume: Number(projectStats.total_volume),
        platformRevenue: Number(revenueResult.rows[0].platform_revenue),
      },
      recentDisputes: recentDisputesResult.rows,
      recentUnmatched: recentUnmatchedResult.rows,
      recentProjects: recentProjectsResult.rows,
    });
  } catch (err) { next(err); }
};