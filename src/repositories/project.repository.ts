import pool from '../config/database';
import { Project, ProjectState } from '../types';

export class ProjectRepository {
  async create(data: {
    title: string;
    description: string;
    providerId: string;
    clientEmail?: string;
    totalAmount: number;
    currency: string;
    shareUrl: string;
  }): Promise<Project> {
    const result = await pool.query<Project>(
      `INSERT INTO projects (title, description, provider_id, client_email, total_amount, currency, share_url, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')
       RETURNING *`,
      [data.title, data.description, data.providerId, data.clientEmail ?? null, data.totalAmount, data.currency, data.shareUrl]
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<Project | null> {
    const result = await pool.query<Project>(`SELECT * FROM projects WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async findByIdWithDetails(id: string): Promise<Record<string, unknown> | null> {
    const result = await pool.query(
      `SELECT p.*,
        json_build_object('id', pu.id, 'name', pu.name, 'email', pu.email) AS provider,
        json_build_object('id', cu.id, 'name', cu.name, 'email', cu.email) AS client,
        (SELECT json_agg(m ORDER BY m.order_index) FROM milestones m WHERE m.project_id = p.id) AS milestones
       FROM projects p
       LEFT JOIN users pu ON p.provider_id = pu.id
       LEFT JOIN users cu ON p.client_id = cu.id
       WHERE p.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async findByVirtualAccountNumber(accountNumber: string): Promise<Project | null> {
    const result = await pool.query<Project>(
      `SELECT * FROM projects WHERE virtual_account_number = $1`,
      [accountNumber]
    );
    return result.rows[0] ?? null;
  }

  async updateState(id: string, state: ProjectState): Promise<void> {
    await pool.query(`UPDATE projects SET state = $1 WHERE id = $2`, [state, id]);
  }

  async updateVirtualAccount(id: string, data: {
    virtualAccountId: string;
    virtualAccountNumber: string;
    virtualAccountBank: string;
    virtualAccountName: string;
    nombaAccountRef: string;
  }): Promise<void> {
    await pool.query(
      `UPDATE projects SET
        virtual_account_id = $1,
        virtual_account_number = $2,
        virtual_account_bank = $3,
        virtual_account_name = $4,
        nomba_account_ref = $5,
        state = 'PENDING_PAYMENT',
        payment_timeout_at = NOW() + INTERVAL '7 days'
       WHERE id = $6`,
      [data.virtualAccountId, data.virtualAccountNumber, data.virtualAccountBank, data.virtualAccountName, data.nombaAccountRef, id]
    );
  }

  async setClient(id: string, clientId: string): Promise<void> {
    await pool.query(`UPDATE projects SET client_id = $1, state = 'PENDING_PAYMENT' WHERE id = $2`, [clientId, id]);
  }

  async updateAmountPaid(id: string, amountPaid: number, overpayment: number): Promise<void> {
    await pool.query(
      `UPDATE projects SET amount_paid = $1, overpayment_amount = $2 WHERE id = $3`,
      [amountPaid, overpayment, id]
    );
  }

  async findByUser(userId: string, role: 'provider' | 'client', filters: {
    state?: ProjectState;
    page: number;
    limit: number;
  }): Promise<{ projects: Project[]; total: number }> {
    const offset = (filters.page - 1) * filters.limit;
    const column = role === 'provider' ? 'provider_id' : 'client_id';
    const params: unknown[] = [userId];
    const conditions = [`${column} = $1`];

    if (filters.state) {
      conditions.push(`state = $${params.length + 1}`);
      params.push(filters.state);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await pool.query(`SELECT COUNT(*) FROM projects ${where}`, params);
    const projectsResult = await pool.query<Project>(
      `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, offset]
    );

    return { projects: projectsResult.rows, total: parseInt(countResult.rows[0].count) };
  }

  async findTimedOutProjects(): Promise<Project[]> {
    const result = await pool.query<Project>(
      `SELECT * FROM projects WHERE state IN ('PENDING_PAYMENT', 'PARTIALLY_PAID') AND payment_timeout_at < NOW()`
    );
    return result.rows;
  }

  async findAll(filters: { state?: ProjectState; page: number; limit: number }): Promise<{ projects: Project[]; total: number }> {
    const offset = (filters.page - 1) * filters.limit;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (filters.state) {
      conditions.push(`state = $${params.length + 1}`);
      params.push(filters.state);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(`SELECT COUNT(*) FROM projects ${where}`, params);
    const projectsResult = await pool.query<Project>(
      `SELECT * FROM projects ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, offset]
    );

    return { projects: projectsResult.rows, total: parseInt(countResult.rows[0].count) };
  }
}

export const projectRepository = new ProjectRepository();
