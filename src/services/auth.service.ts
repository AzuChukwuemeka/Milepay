import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { userRepository } from '../repositories/user.repository';
import { RegisterDTO, LoginDTO, AuthResponse, JWTPayload } from '../types';
import { AppError, ValidationError, UnauthorizedError, NotFoundError } from '../utils/response';
import { sendEmail } from './email.service';

export class AuthService {
  async register(data: RegisterDTO): Promise<AuthResponse> {
    const existing = await userRepository.findByEmail(data.email);
    if (existing) throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await userRepository.create({
      email: data.email,
      phone: data.phone,
      name: data.name,
      passwordHash,
      role: data.role,
      emailVerifyToken: verifyToken,
      emailVerifyExpires: verifyExpires,
    });

    const { pool } = await import('../config/database');
    if (data.role === 'provider') {
      await pool.query(`INSERT INTO provider_profiles (user_id) VALUES ($1)`, [user.id]);
    } else {
      await pool.query(`INSERT INTO client_profiles (user_id) VALUES ($1)`, [user.id]);
    }

    await sendEmail({
      to: data.email,
      subject: 'Verify your MilePay email',
      html: `
        <h2>Welcome to MilePay, ${data.name}!</h2>
        <p>Click the link below to verify your email address:</p>
        <a href="${process.env.APP_URL}/v1/verify-email?token=${verifyToken}">Verify Email</a>
        <p>This link expires in 24 hours.</p>
      `,
    });

    const token = this.generateToken(user.id, user.email, user.role);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        onboarding_complete: user.onboarding_complete,
        email_verified: user.email_verified,
      },
    };
  }

  async login(data: LoginDTO): Promise<AuthResponse> {
    const user = await userRepository.findByEmail(data.email);
    if (!user) throw new UnauthorizedError('Invalid email or password');

    const passwordMatch = await bcrypt.compare(data.password, user.password_hash);
    if (!passwordMatch) throw new UnauthorizedError('Invalid email or password');

    if (user.is_suspended) throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended');

    const token = this.generateToken(user.id, user.email, user.role);

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        onboarding_complete: user.onboarding_complete,
        email_verified: user.email_verified,
      },
    };
  }

  async verifyEmail(token: string): Promise<void> {
    const user = await userRepository.findByEmailVerifyToken(token);
    if (!user) throw new ValidationError('Invalid or expired verification token');

    await userRepository.verifyEmail(user.id);
  }

  async forgotPassword(email: string): Promise<void> {
    const user = await userRepository.findByEmail(email);
    if (!user) return;

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

    await userRepository.setPasswordResetToken(user.id, resetToken, resetExpires);

    await sendEmail({
      to: email,
      subject: 'Reset your MilePay password',
      html: `
        <h2>Password Reset</h2>
        <p>Click the link below to reset your password:</p>
        <a href="${process.env.APP_URL}/v1/reset-password?token=${resetToken}">Reset Password</a>
        <p>This link expires in 1 hour.</p>
      `,
    });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await userRepository.findByPasswordResetToken(token);
    if (!user) throw new ValidationError('Invalid or expired reset token');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await userRepository.resetPassword(user.id, passwordHash);
  }

  async getMe(userId: string): Promise<Record<string, unknown>> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User');

    const { pool } = await import('../config/database');
    let profile = null;

    if (user.role === 'provider') {
      const result = await pool.query(`SELECT * FROM provider_profiles WHERE user_id = $1`, [userId]);
      profile = result.rows[0] ?? null;
    } else if (user.role === 'client') {
      const result = await pool.query(`SELECT * FROM client_profiles WHERE user_id = $1`, [userId]);
      profile = result.rows[0] ?? null;
    }

    return { ...user, profile };
  }

  private generateToken(userId: string, email: string, role: string): string {
    const payload: JWTPayload = { userId, email, role: role as JWTPayload['role'] };
    return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' });
  }
}

export const authService = new AuthService();