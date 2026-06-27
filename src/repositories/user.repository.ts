import pool from '../config/database';
import { User, UserRole } from '../types';

export class UserRepository {
  async create(data: {
    email: string;
    phone: string;
    name: string;
    passwordHash: string;
    role: UserRole;
    emailVerifyToken: string;
    emailVerifyExpires: Date;
  }): Promise<User> {
    const result = await pool.query<User>(
      `INSERT INTO users (email, phone, name, password_hash, role, email_verify_token, email_verify_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, phone, name, role, email_verified, onboarding_complete, is_suspended, created_at, updated_at`,
      [data.email, data.phone, data.name, data.passwordHash, data.role, data.emailVerifyToken, data.emailVerifyExpires]
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<User | null> {
    const result = await pool.query<User>(
      `SELECT id, email, phone, name, role, email_verified, onboarding_complete, is_suspended, created_at, updated_at
       FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByEmail(email: string): Promise<(User & { password_hash: string }) | null> {
    const result = await pool.query<User & { password_hash: string }>(
      `SELECT id, email, phone, name, role, password_hash, email_verified, onboarding_complete, is_suspended, created_at, updated_at
       FROM users WHERE email = $1`,
      [email]
    );
    return result.rows[0] ?? null;
  }

  async findByEmailVerifyToken(token: string): Promise<User | null> {
    const result = await pool.query<User>(
      `SELECT id, email, phone, name, role, email_verified, onboarding_complete, is_suspended, created_at, updated_at
       FROM users WHERE email_verify_token = $1 AND email_verify_expires > NOW()`,
      [token]
    );
    return result.rows[0] ?? null;
  }

  async findByPasswordResetToken(token: string): Promise<User | null> {
    const result = await pool.query<User>(
      `SELECT id, email, phone, name, role, email_verified, onboarding_complete, is_suspended, created_at, updated_at
       FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()`,
      [token]
    );
    return result.rows[0] ?? null;
  }

  async verifyEmail(userId: string): Promise<void> {
    await pool.query(
      `UPDATE users SET email_verified = TRUE, email_verify_token = NULL, email_verify_expires = NULL
       WHERE id = $1`,
      [userId]
    );
  }

  async setPasswordResetToken(userId: string, token: string, expires: Date): Promise<void> {
    await pool.query(
      `UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3`,
      [token, expires, userId]
    );
  }

  async resetPassword(userId: string, passwordHash: string): Promise<void> {
    await pool.query(
      `UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL
       WHERE id = $2`,
      [passwordHash, userId]
    );
  }

  async markOnboardingComplete(userId: string): Promise<void> {
    await pool.query(`UPDATE users SET onboarding_complete = TRUE WHERE id = $1`, [userId]);
  }

  async suspend(userId: string, reason: string): Promise<void> {
    await pool.query(
      `UPDATE users SET is_suspended = TRUE, suspension_reason = $1 WHERE id = $2`,
      [reason, userId]
    );
  }

  async findAll(filters: { role?: string; page: number; limit: number }): Promise<{ users: User[]; total: number }> {
    const offset = (filters.page - 1) * filters.limit;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.role) {
      conditions.push(`role = $${params.length + 1}`);
      params.push(filters.role);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM users ${where}`, params);
    const usersResult = await pool.query<User>(
      `SELECT id, email, phone, name, role, email_verified, onboarding_complete, is_suspended, created_at, updated_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, offset]
    );

    return { users: usersResult.rows, total: parseInt(countResult.rows[0].count) };
  }
}

export const userRepository = new UserRepository();
