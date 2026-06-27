import { Router } from 'express';
import { authenticate, requireRole, requireEmailVerified } from '../middleware/auth.middleware';

// Controllers
import * as auth from '../controllers/auth.controller';
import * as project from '../controllers/project.controller';
import * as misc from '../controllers/misc.controller';

const router = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────
router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.post('/auth/verify-email', auth.verifyEmail);
router.post('/auth/forgot-password', auth.forgotPassword);
router.post('/auth/reset-password', auth.resetPassword);
router.get('/auth/me', authenticate, auth.getMe);

// ─── Onboarding ───────────────────────────────────────────────────────────────
router.post('/onboarding/provider/profile', authenticate, requireRole('provider'), misc.providerProfile);
router.post('/onboarding/provider/identity', authenticate, requireRole('provider'), misc.providerIdentity);
router.post('/onboarding/provider/bank', authenticate, requireRole('provider'), misc.providerBank);
router.post('/onboarding/provider/confirm', authenticate, requireRole('provider'), misc.providerConfirm);
router.post('/onboarding/client/profile', authenticate, requireRole('client'), misc.clientProfile);
router.post('/onboarding/client/confirm', authenticate, requireRole('client'), misc.clientConfirm);
router.get('/banks', misc.getBanks);

// ─── Projects ─────────────────────────────────────────────────────────────────
router.get('/projects', authenticate, project.listProjects);
router.post('/projects', authenticate, requireRole('provider'), requireEmailVerified, project.createProject);
router.get('/projects/:id/public', project.getPublicProject);
router.get('/projects/:id', authenticate, project.getProject);
router.post('/projects/:id/accept', authenticate, requireRole('client'), project.acceptProject);
router.post('/projects/:id/cancel', authenticate, project.cancelProject);
router.get('/projects/:id/audit', authenticate, project.getAuditLog);
router.get('/projects/:id/payments', authenticate, project.getProjectPayments);

// ─── Milestones ───────────────────────────────────────────────────────────────
router.get('/projects/:id/milestones/:mid', authenticate, project.getMilestone);
router.post('/projects/:id/milestones/:mid/submit', authenticate, requireRole('provider'), project.submitMilestone);
router.post('/projects/:id/milestones/:mid/approve', authenticate, requireRole('client'), project.approveMilestone);
router.post('/projects/:id/milestones/:mid/request-revision', authenticate, requireRole('client'), project.requestRevision);
router.post('/projects/:id/milestones/:mid/dispute', authenticate, requireRole('client'), project.disputeMilestone);
router.post('/projects/:id/milestones/:mid/counter-evidence', authenticate, requireRole('provider'), project.submitCounterEvidence);

// ─── Webhooks ─────────────────────────────────────────────────────────────────
router.post('/webhooks/nomba', misc.nombaWebhook);

// ─── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications', authenticate, misc.getNotifications);
router.post('/notifications/:id/read', authenticate, misc.markNotificationRead);
router.post('/notifications/read-all', authenticate, misc.markAllNotificationsRead);

// ─── Admin ────────────────────────────────────────────────────────────────────
router.get('/admin/disputes', authenticate, requireRole('admin'), misc.adminGetDisputes);
router.post('/admin/disputes/:id/resolve', authenticate, requireRole('admin'), misc.adminResolveDispute);
router.get('/admin/unmatched-payments', authenticate, requireRole('admin'), misc.adminGetUnmatched);
router.post('/admin/unmatched-payments/:id/resolve', authenticate, requireRole('admin'), misc.adminResolveUnmatched);
router.get('/admin/transactions', authenticate, requireRole('admin'), misc.adminGetTransactions);
router.get('/admin/users', authenticate, requireRole('admin'), misc.adminGetUsers);
router.post('/admin/users/:id/verify', authenticate, requireRole('admin'), misc.adminVerifyUser);
router.post('/admin/users/:id/suspend', authenticate, requireRole('admin'), misc.adminSuspendUser);

export default router;
