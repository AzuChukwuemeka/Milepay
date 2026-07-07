import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '../services/auth.service';
import { sendSuccess, sendError } from '../utils/response';

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  password: z.string().min(8),
  role: z.enum(['provider', 'client']),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * @swagger
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, phone, password, role]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Tunde Adewale
 *               email:
 *                 type: string
 *                 format: email
 *                 example: tunde@example.com
 *               phone:
 *                 type: string
 *                 example: "08012345678"
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: securepassword
 *               role:
 *                 type: string
 *                 enum: [provider, client]
 *     responses:
 *       201:
 *         description: User created. Email verification sent.
 *       409:
 *         description: Email already taken
 */
export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'VALIDATION_ERROR', parsed.error.errors[0].message, parsed.error.errors[0].path[0] as string);
      return;
    }
    const result = await authService.register(parsed.data);
    sendSuccess(res, result, 'Registration successful. Please verify your email.', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@milepay.com
 *               password:
 *                 type: string
 *                 example: Admin@123456
 *           examples:
 *             admin_login:
 *               summary: Admin Login
 *               value:
 *                 email: admin@milepay.com
 *                 password: Admin@123456
 *     responses:
 *       200:
 *         description: Login successful. Returns JWT token.
 *       401:
 *         description: Invalid credentials
 */
export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Invalid email or password');
      return;
    }
    const result = await authService.login(parsed.data);
    sendSuccess(res, result, 'Login successful');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /auth/verify-email:
 *   post:
 *     tags: [Auth]
 *     summary: Verify email with token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email verified successfully
 *       400:
 *         description: Invalid or expired token
 */
export const verifyEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const frontendSignInUrl = "https://milepay-nomba.vercel.app"
  try {
    const { token } = req.body;
    if (!token) { sendError(res, 400, 'VALIDATION_ERROR', 'Token is required', 'token'); return; }
    await authService.verifyEmail(token);
    res.redirect(`${frontendSignInUrl}/login`);
    // sendSuccess(res, { success: true }, 'Email verified successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request password reset email
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: If email exists, reset link sent
 */
export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = req.body;
    if (!email) { sendError(res, 400, 'VALIDATION_ERROR', 'Email is required', 'email'); return; }
    await authService.forgotPassword(email);
    sendSuccess(res, { success: true }, 'If an account exists with this email, a reset link has been sent');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password using token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       200:
 *         description: Password reset successful
 */
export const resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) { sendError(res, 400, 'VALIDATION_ERROR', 'Token and new password required'); return; }
    if (newPassword.length < 8) { sendError(res, 400, 'VALIDATION_ERROR', 'Password must be at least 8 characters', 'newPassword'); return; }
    await authService.resetPassword(token, newPassword);
    sendSuccess(res, { success: true }, 'Password reset successful');
  } catch (err) {
    next(err);
  }
};

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user with profile
 *       401:
 *         description: Unauthorized
 */
export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const result = await authService.getMe(req.user!.userId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

const createAdminSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  password: z.string().min(8),
});

/**
 * @swagger
 * /auth/create-admin:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new admin account (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, phone, password]
 *             properties:
 *               name:
 *                 type: string
 *                 example: New Admin
 *               email:
 *                 type: string
 *                 format: email
 *                 example: newadmin@milepay.com
 *               phone:
 *                 type: string
 *                 example: "08098765432"
 *               password:
 *                 type: string
 *                 minLength: 8
 *                 example: SecureAdmin@2024
 *           examples:
 *             create_admin:
 *               summary: Create new admin account
 *               value:
 *                 name: New Admin
 *                 email: newadmin@milepay.com
 *                 phone: "08098765432"
 *                 password: SecureAdmin@2024
 *     responses:
 *       201:
 *         description: Admin account created successfully
 *       409:
 *         description: Email already taken
 *       403:
 *         description: Forbidden - only admins can create admin accounts
 */
export const createAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const parsed = createAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, 'VALIDATION_ERROR', parsed.error.errors[0].message, parsed.error.errors[0].path[0] as string);
      return;
    }
    const result = await authService.createAdmin(parsed.data);
    sendSuccess(res, result, 'Admin account created successfully', 201);
  } catch (err) {
    next(err);
  }
};
