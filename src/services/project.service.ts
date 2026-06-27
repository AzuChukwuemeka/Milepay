import { projectRepository } from '../repositories/project.repository';
import { milestoneRepository } from '../repositories/milestone.repository';
import { auditRepository } from '../repositories/shared.repository';
import { notificationRepository } from '../repositories/shared.repository';
import { CreateProjectDTO, ProjectState, ProjectListQuery } from '../types';
import { createVirtualAccount } from './nomba.service';
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from '../utils/response';

export class ProjectService {
  async createProject(providerId: string, data: CreateProjectDTO): Promise<Record<string, unknown>> {
    // Validate milestone amounts sum to total
    const milestoneTotal = data.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (Math.abs(milestoneTotal - data.totalAmount) > 0.01) {
      throw new ValidationError('Milestone amounts must sum to the total project amount');
    }

    if (data.milestones.length === 0 || data.milestones.length > 10) {
      throw new ValidationError('Projects must have between 1 and 10 milestones');
    }

    const project = await projectRepository.create({
      title: data.title,
      description: data.description,
      providerId,
      clientEmail: data.clientEmail,
      totalAmount: data.totalAmount,
      currency: data.currency || 'NGN',
      shareUrl: '', // will update below
    });

    const shareUrl = `${process.env.APP_URL}/project/${project.id}`;
    await projectRepository.updateState(project.id, 'DRAFT');

    // Update share URL
    const { pool } = await import('../config/database');
    await pool.query(`UPDATE projects SET share_url = $1 WHERE id = $2`, [shareUrl, project.id]);

    // Create milestones — first is IN_PROGRESS, rest LOCKED
    const milestonesData = data.milestones.map((m, i) => ({
      projectId: project.id,
      title: m.title,
      description: m.description,
      deliverable: m.deliverable,
      amount: m.amount,
      orderIndex: i,
    }));

    const milestones = await milestoneRepository.createMany(milestonesData);

    await auditRepository.log({
      projectId: project.id,
      eventType: 'PROJECT_CREATED',
      actorId: providerId,
      actorRole: 'provider',
      metadata: { title: data.title, totalAmount: data.totalAmount, milestoneCount: milestones.length },
    });

    return { ...project, share_url: shareUrl, milestones };
  }

  async getPublicProject(projectId: string): Promise<Record<string, unknown>> {
    const project = await projectRepository.findByIdWithDetails(projectId);
    if (!project) throw new NotFoundError('Project');

    const milestones = await milestoneRepository.findByProjectId(projectId);

    return { ...project, milestones };
  }

  async getProject(projectId: string, userId: string, userRole: string): Promise<Record<string, unknown>> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    if (userRole !== 'admin' && project.provider_id !== userId && project.client_id !== userId) {
      throw new ForbiddenError();
    }

    const milestones = await milestoneRepository.findByProjectId(projectId);
    const auditLog = await auditRepository.findByProjectId(projectId);

    return { ...project, milestones, audit_log: auditLog };
  }

  async acceptProject(projectId: string, clientId: string): Promise<Record<string, unknown>> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    if (project.state !== 'DRAFT' && project.state !== 'PENDING_ACCEPTANCE') {
      throw new ConflictError(`Project cannot be accepted in state: ${project.state}`);
    }

    if (project.provider_id === clientId) {
      throw new ForbiddenError('You cannot accept your own project');
    }

    // Set client
    await projectRepository.setClient(projectId, clientId);

    // Provision Nomba virtual account
    const accountRef = `PROJ-${projectId.replace(/-/g, '').substring(0, 16)}`;

    const { pool } = await import('../config/database');
    const providerResult = await pool.query(
      `SELECT u.name FROM users u WHERE u.id = $1`,
      [project.provider_id]
    );
    const providerName = providerResult.rows[0]?.name ?? 'MilePay Project';

    const virtualAccount = await createVirtualAccount({
       accountRef,
       accountName: `${providerName} - ${project.title}`.substring(0, 50),
       expectedAmount: Number(project.total_amount),
    });
    
    await projectRepository.updateVirtualAccount(projectId, {
      virtualAccountId: virtualAccount.accountRef,
      virtualAccountNumber: virtualAccount.accountNumber,
      virtualAccountBank: virtualAccount.bankName,
      virtualAccountName: virtualAccount.accountName,
      nombaAccountRef: accountRef,
    });

    await auditRepository.log({
      projectId,
      eventType: 'PROJECT_ACCEPTED',
      actorId: clientId,
      actorRole: 'client',
      metadata: { virtualAccountNumber: virtualAccount.accountNumber },
    });

    await notificationRepository.create({
      userId: project.provider_id,
      title: 'Project Accepted',
      message: `Your project "${project.title}" has been accepted. Waiting for client payment.`,
      type: 'PROJECT_ACCEPTED',
      metadata: { projectId },
    });

    return {
      virtualAccount: {
        accountNumber: virtualAccount.accountNumber,
        bankName: virtualAccount.bankName,
        accountName: virtualAccount.accountName,
        amount: project.total_amount,
        currency: project.currency,
      },
    };
  }

  async cancelProject(projectId: string, userId: string, reason: string): Promise<void> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    const cancelableStates: ProjectState[] = ['DRAFT', 'PENDING_ACCEPTANCE', 'PENDING_PAYMENT'];
    if (!cancelableStates.includes(project.state)) {
      throw new ConflictError('Project cannot be cancelled at this stage');
    }

    if (project.provider_id !== userId && project.client_id !== userId) {
      throw new ForbiddenError();
    }

    await projectRepository.updateState(projectId, 'CANCELLED');

    await auditRepository.log({
      projectId,
      eventType: 'PROJECT_CANCELLED',
      actorId: userId,
      metadata: { reason },
    });
  }

  async listProjects(userId: string, query: ProjectListQuery): Promise<Record<string, unknown>> {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 50);
    const role = query.role || 'provider';

    const { projects, total } = await projectRepository.findByUser(userId, role, {
      state: query.state,
      page,
      limit,
    });

    return { projects, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async getAuditLog(projectId: string, userId: string, userRole: string): Promise<unknown[]> {
    const project = await projectRepository.findById(projectId);
    if (!project) throw new NotFoundError('Project');

    if (userRole !== 'admin' && project.provider_id !== userId && project.client_id !== userId) {
      throw new ForbiddenError();
    }

    return auditRepository.findByProjectId(projectId);
  }
}

export const projectService = new ProjectService();
