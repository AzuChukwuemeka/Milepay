import { Router } from 'express';
import { authenticate, requireRole, requireEmailVerified } from '../middleware/auth.middleware';
import { authService } from '../services/auth.service';
import { upload } from '../middleware/upload.middleware';

// Controllers
import * as auth from '../controllers/auth.controller';
import * as project from '../controllers/project.controller';
import * as dashboard from '../controllers/dashboard.controller';
import * as misc from '../controllers/misc.controller';

const router = Router();

// ─── Email Verification (browser link) ───────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      res.status(400).send(`
        <html>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h2>Invalid Link</h2>
            <p>This verification link is invalid.</p>
          </body>
        </html>
      `);
      return;
    }
    await authService.verifyEmail(token as string);
    const frontendSignInUrl = "https://milepay-nomba.vercel.app/login"
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Email Verified</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding-top: 80px;
          }

          a {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 24px;
            background: #2563eb;
            color: white;
            text-decoration: none;
            border-radius: 8px;
          }
        </style>
      </head>

      <body>
        <h1>Milepay Verification Successful</h1>
        <p>Your email has been verified. You can now sign in.</p>
        <a href="${frontendSignInUrl}">
          Go back to Login
        </a>
      </body>
    </html>
  `);
  } catch {
    res.status(400).send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2>❌ Verification Failed</h2>
          <p>This link is invalid or has expired.</p>
        </body>
      </html>
    `);
  }
});

// ─── Password Reset (browser link) ───────────────────────────────────────────
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  res.setHeader('Content-Type', 'text/html');
  res.send(`
    <html>
      <head>
        <title>Reset Password — MilePay</title>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; }
          h2 { color: #0D3B2B; }
          input { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #0D3B2B; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
          .msg { padding: 10px; border-radius: 4px; margin-top: 12px; }
          .success { background: #d4edda; color: #155724; }
          .error { background: #f8d7da; color: #721c24; }
        </style>
      </head>
      <body>
        <h2>Reset your password</h2>
        <input type="password" id="password" placeholder="New password (min 8 characters)"/>
        <input type="password" id="confirm" placeholder="Confirm new password"/>
        <button onclick="reset()">Reset Password</button>
        <div id="msg"></div>
        <script>
          async function reset() {
            const password = document.getElementById('password').value;
            const confirm = document.getElementById('confirm').value;
            const msg = document.getElementById('msg');
            if (password.length < 8) { msg.className='msg error'; msg.innerText='Password must be at least 8 characters'; return; }
            if (password !== confirm) { msg.className='msg error'; msg.innerText='Passwords do not match'; return; }
            const res = await fetch('/v1/auth/reset-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: '${token}', newPassword: password })
            });
            const data = await res.json();
            if (data.success) {
              msg.className='msg success';
              msg.innerText='Password reset successfully. You can now log in.';
            } else {
              msg.className='msg error';
              msg.innerText=data.error?.message || 'Something went wrong';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
router.post('/auth/register', auth.register);
router.post('/auth/login', auth.login);
router.post('/auth/verify-email', auth.verifyEmail);
router.post('/auth/forgot-password', auth.forgotPassword);
router.post('/auth/reset-password', auth.resetPassword);
router.get('/auth/me', authenticate, auth.getMe);
router.post('/auth/create-admin', authenticate, requireRole('admin'), auth.createAdmin);

// ─── Onboarding ───────────────────────────────────────────────────────────────
router.post(
  '/onboarding/provider/profile',
  authenticate,
  requireRole('provider'),
  upload.fields([
    { name: 'profilePhoto', maxCount: 1 },
    { name: 'portfolioFile', maxCount: 1 },
  ]),
  misc.providerProfile
);
router.post(
  '/onboarding/provider/identity',
  authenticate,
  requireRole('provider'),
  upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]),
  misc.providerIdentity
);
router.post('/onboarding/provider/bank', authenticate, requireRole('provider'), misc.providerBank);
router.post('/onboarding/provider/confirm', authenticate, requireRole('provider'), misc.providerConfirm);
router.post('/onboarding/client/profile', authenticate, requireRole('client'), misc.clientProfile);
router.post('/onboarding/client/confirm', authenticate, requireRole('client'), misc.clientConfirm);
router.post('/banks/lookup', misc.bankLookup);
router.get('/banks', misc.getBanks);

// ─── Generic Upload (Cloudinary) ──────────────────────────────────────────────
router.post('/upload', authenticate, upload.single('file'), misc.uploadFile);

// ─── Provider Public Profile & Earnings ───────────────────────────────────────
router.get('/providers/:username', misc.getProviderProfile);
router.get('/earnings', authenticate, requireRole('provider'), misc.getProviderEarnings);

// ─── Projects ─────────────────────────────────────────────────────────────────
router.get('/projects', authenticate, project.listProjects);
router.post('/projects', authenticate, requireRole('provider'), requireEmailVerified, project.createProject);
router.get('/projects/:id/public', project.getPublicProject);
router.get('/projects/:id', authenticate, project.getProject);
router.post('/projects/:id/accept', authenticate, requireRole('client'), project.acceptProject);
router.post('/projects/:id/cancel', authenticate, project.cancelProject);
router.get('/projects/:id/audit', authenticate, project.getAuditLog);
router.get('/projects/:id/payments', authenticate, project.getProjectPayments);
router.get('/projects/:id/payments/instructions', authenticate, project.getProjectPaymentInstructions);
router.post('/projects/:id/refund-overpayment', authenticate, requireRole('client'), project.refundOverpayment);

// ─── Dashboards ───────────────────────────────────────────────────────────────
router.get('/dashboard/provider', authenticate, requireRole('provider'), dashboard.providerDashboard);
router.get('/dashboard/client', authenticate, requireRole('client'), dashboard.clientDashboard);
router.get('/dashboard/admin', authenticate, requireRole('admin'), dashboard.adminDashboard);

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