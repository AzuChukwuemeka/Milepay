import pool from '../config/database';
import { AuditEvent, Notification, Payment, Dispute, DisputeOutcome } from '../types';

// ─── Audit Repository ─────────────────────────────────────────────────────────

export class AuditRepository {
  async log(data: {
    projectId: string;
    milestoneId?: string;
    eventType: string;
    actorId?: string;
    actorRole?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO audit_events (project_id, milestone_id, event_type, actor_id, actor_role, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [data.projectId, data.milestoneId ?? null, data.eventType, data.actorId ?? null, data.actorRole ?? null, data.metadata ?? {}]
    );
  }


  
  async findByProjectId(projectId: string): Promise<AuditEvent[]> {
    const result = await pool.query<AuditEvent>(
      `SELECT * FROM audit_events WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId]
    );
    return result.rows;
  }
}

// ─── Notification Repository ──────────────────────────────────────────────────

export class NotificationRepository {
  async create(data: {
    userId: string;
    title: string;
    message: string;
    type: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.userId, data.title, data.message, data.type, data.metadata ?? {}]
    );
  }

  async findByUserId(userId: string, unreadOnly: boolean, page: number, limit: number): Promise<{ notifications: Notification[]; total: number }> {
    const offset = (page - 1) * limit;
    const where = unreadOnly ? 'WHERE user_id = $1 AND is_read = FALSE' : 'WHERE user_id = $1';

    const countResult = await pool.query(`SELECT COUNT(*) FROM notifications ${where}`, [userId]);
    const result = await pool.query<Notification>(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return { notifications: result.rows, total: parseInt(countResult.rows[0].count) };
  }

  async markRead(id: string, userId: string): Promise<void> {
    await pool.query(`UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`, [id, userId]);
  }

  async markAllRead(userId: string): Promise<void> {
    await pool.query(`UPDATE notifications SET is_read = TRUE WHERE user_id = $1`, [userId]);
  }
}

// ─── Payment Repository ───────────────────────────────────────────────────────

export class PaymentRepository {
  async create(data: {
    projectId?: string;
    nombaTransactionId: string;
    nombaEventId: string;
    amount: number;
    currency: string;
    status: string;
    rawPayload: Record<string, unknown>;
  }): Promise<Payment> {
    const result = await pool.query<Payment>(
      `INSERT INTO payments (project_id, nomba_transaction_id, nomba_event_id, amount, currency, status, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.projectId ?? null, data.nombaTransactionId, data.nombaEventId, data.amount, data.currency, data.status, data.rawPayload]
    );
    return result.rows[0];
  }

  async isEventProcessed(eventId: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT event_id FROM processed_webhook_events WHERE event_id = $1`,
      [eventId]
    );
    return result.rows.length > 0;
  }

  async markEventProcessed(eventId: string): Promise<void> {
    await pool.query(
      `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [eventId]
    );
  }

  async findByProjectId(projectId: string): Promise<Payment[]> {
    const result = await pool.query<Payment>(
      `SELECT * FROM payments WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId]
    );
    return result.rows;
  }

  async findUnmatched(page: number, limit: number): Promise<{ payments: Payment[]; total: number }> {
    const offset = (page - 1) * limit;
    const countResult = await pool.query(`SELECT COUNT(*) FROM payments WHERE status = 'UNMATCHED'`);
    const result = await pool.query<Payment>(
      `SELECT * FROM payments WHERE status = 'UNMATCHED' ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return { payments: result.rows, total: parseInt(countResult.rows[0].count) };
  }

  async updateStatus(id: string, status: string, projectId?: string): Promise<void> {
    if (projectId) {
      await pool.query(`UPDATE payments SET status = $1, project_id = $2 WHERE id = $3`, [status, projectId, id]);
    } else {
      await pool.query(`UPDATE payments SET status = $1 WHERE id = $2`, [status, id]);
    }
  }

  async findAll(filters: { page: number; limit: number }): Promise<{ payments: Payment[]; total: number }> {
    const offset = (filters.page - 1) * filters.limit;
    const countResult = await pool.query(`SELECT COUNT(*) FROM payments`);
    const result = await pool.query<Payment>(
      `SELECT * FROM payments ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [filters.limit, offset]
    );
    return { payments: result.rows, total: parseInt(countResult.rows[0].count) };
  }
}

// ─── Dispute Repository ───────────────────────────────────────────────────────

export class DisputeRepository {
  async create(data: {
    projectId: string;
    milestoneId: string;
    raisedBy: string;
    reason: string;
    description: string;
    evidenceFiles: string[];
  }): Promise<Dispute> {
    const result = await pool.query<Dispute>(
      `INSERT INTO disputes (project_id, milestone_id, raised_by, reason, description, evidence_files)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [data.projectId, data.milestoneId, data.raisedBy, data.reason, data.description, data.evidenceFiles]
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<Dispute | null> {
    const result = await pool.query<Dispute>(`SELECT * FROM disputes WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async findByMilestoneId(milestoneId: string): Promise<Dispute | null> {
    const result = await pool.query<Dispute>(
      `SELECT * FROM disputes WHERE milestone_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [milestoneId]
    );
    return result.rows[0] ?? null;
  }

  async addCounterEvidence(id: string, description: string, files: string[]): Promise<void> {
    await pool.query(
      `UPDATE disputes SET counter_description = $1, counter_evidence_files = $2 WHERE id = $3`,
      [description, files, id]
    );
  }

  async resolve(id: string, data: {
    outcome: DisputeOutcome;
    adminNotes: string;
    resolvedBy: string;
  }): Promise<void> {
    await pool.query(
      `UPDATE disputes SET outcome = $1, admin_notes = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $4`,
      [data.outcome, data.adminNotes, data.resolvedBy, id]
    );
  }

  async findAll(filters: { outcome?: string; page: number; limit: number }): Promise<{ disputes: Dispute[]; total: number }> {
    const offset = (filters.page - 1) * filters.limit;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.outcome) {
      conditions.push(`outcome = $${params.length + 1}`);
      params.push(filters.outcome);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM disputes ${where}`, params);
    const result = await pool.query<Dispute>(
      `SELECT * FROM disputes ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, offset]
    );

    return { disputes: result.rows, total: parseInt(countResult.rows[0].count) };
  }
}

// ─── Client Repository ────────────────────────────────────────────────────────

export class ClientRepository {
  // Called from the payment_success webhook once we know which project (and
  // therefore which client) a payment belongs to. Nomba's `customer` object
  // gives us the sender's own bank account — the account we'd pay a refund
  // back to. Any of these can be missing depending on payment channel, so
  // every field is written as-is (possibly null) rather than assumed present.
  // Overwrites on every payment so the account on file is always the most
  // recently used one.
  async upsertBankDetails(
    userId: string,
    data: { bankCode?: string; bankName?: string; accountNumber?: string; accountName?: string }
  ): Promise<void> {
    await pool.query(
      `UPDATE client_profiles
       SET bank_code = $1, bank_name = $2, account_number = $3, account_name = $4
       WHERE user_id = $5`,
      [data.bankCode ?? null, data.bankName ?? null, data.accountNumber ?? null, data.accountName ?? null, userId]
    );
  }
}

export const clientRepository = new ClientRepository();
export const auditRepository = new AuditRepository();
export const notificationRepository = new NotificationRepository();
export const paymentRepository = new PaymentRepository();
export const disputeRepository = new DisputeRepository();
