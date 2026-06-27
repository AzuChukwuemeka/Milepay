import pool from '../config/database';
import { Milestone, MilestoneState } from '../types';

export class MilestoneRepository {
  async createMany(milestones: {
    projectId: string;
    title: string;
    description: string;
    deliverable: string;
    amount: number;
    orderIndex: number;
  }[]): Promise<Milestone[]> {
    const values = milestones.map((m, i) => {
      const base = i * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    const params = milestones.flatMap(m => [
      m.projectId, m.title, m.description, m.deliverable, m.amount, m.orderIndex,
    ]);

    const result = await pool.query<Milestone>(
      `INSERT INTO milestones (project_id, title, description, deliverable, amount, order_index)
       VALUES ${values} RETURNING *`,
      params
    );
    return result.rows;
  }

  async findById(id: string): Promise<Milestone | null> {
    const result = await pool.query<Milestone>(`SELECT * FROM milestones WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async findByProjectId(projectId: string): Promise<Milestone[]> {
    const result = await pool.query<Milestone>(
      `SELECT * FROM milestones WHERE project_id = $1 ORDER BY order_index ASC`,
      [projectId]
    );
    return result.rows;
  }

  async findFirstMilestone(projectId: string): Promise<Milestone | null> {
    const result = await pool.query<Milestone>(
      `SELECT * FROM milestones WHERE project_id = $1 ORDER BY order_index ASC LIMIT 1`,
      [projectId]
    );
    return result.rows[0] ?? null;
  }

  async findNextMilestone(projectId: string, currentOrderIndex: number): Promise<Milestone | null> {
    const result = await pool.query<Milestone>(
      `SELECT * FROM milestones WHERE project_id = $1 AND order_index > $2 ORDER BY order_index ASC LIMIT 1`,
      [projectId, currentOrderIndex]
    );
    return result.rows[0] ?? null;
  }

  async updateState(id: string, state: MilestoneState): Promise<void> {
    await pool.query(`UPDATE milestones SET state = $1 WHERE id = $2`, [state, id]);
  }

  async submitDelivery(id: string, data: {
    deliveryNote: string;
    deliveryFiles: string[];
  }): Promise<void> {
    const autoApproveAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
    await pool.query(
      `UPDATE milestones SET state = 'SUBMITTED', delivery_note = $1, delivery_files = $2, auto_approve_at = $3 WHERE id = $4`,
      [data.deliveryNote, data.deliveryFiles, autoApproveAt, id]
    );
  }

  async setRevisionRequested(id: string, notes: string): Promise<void> {
    await pool.query(
      `UPDATE milestones SET state = 'REVISION_REQUESTED', revision_notes = $1, auto_approve_at = NULL WHERE id = $2`,
      [notes, id]
    );
  }

  async setApprovedPendingTransfer(id: string): Promise<void> {
    await pool.query(
      `UPDATE milestones SET state = 'APPROVED_PENDING_TRANSFER', auto_approve_at = NULL WHERE id = $1`,
      [id]
    );
  }

  async setPaid(id: string, transferRef: string): Promise<void> {
    await pool.query(
      `UPDATE milestones SET state = 'PAID', nomba_transfer_ref = $1, paid_at = NOW() WHERE id = $2`,
      [transferRef, id]
    );
  }

  async incrementTransferAttempts(id: string): Promise<number> {
    const result = await pool.query<{ transfer_attempts: number }>(
      `UPDATE milestones SET transfer_attempts = transfer_attempts + 1 WHERE id = $1 RETURNING transfer_attempts`,
      [id]
    );
    return result.rows[0].transfer_attempts;
  }

  async findSubmittedForAutoApproval(): Promise<Milestone[]> {
    const result = await pool.query<Milestone>(
      `SELECT * FROM milestones WHERE state = 'SUBMITTED' AND auto_approve_at < NOW()`
    );
    return result.rows;
  }

  async findPendingTransfers(): Promise<Milestone[]> {
    const result = await pool.query<Milestone>(
      `SELECT * FROM milestones WHERE state = 'APPROVED_PENDING_TRANSFER'`
    );
    return result.rows;
  }
}

export const milestoneRepository = new MilestoneRepository();
