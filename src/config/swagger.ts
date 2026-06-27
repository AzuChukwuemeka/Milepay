import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MilePay API',
      version: '1.0.0',
      description: `
## MilePay — Milestone-Based Payment Platform

Built on Nomba Virtual Accounts. Funds flow exactly as work flows.

### Authentication
Most endpoints require a **Bearer JWT token** in the Authorization header.  
Get your token from \`POST /auth/login\` or \`POST /auth/register\`.

### Key Flows
1. **Provider** registers → completes 4-step onboarding → creates project → shares link
2. **Client** opens link → registers/logs in → accepts project → pays into virtual account
3. Nomba webhook fires → project becomes ACTIVE → provider works on Milestone 1
4. Provider submits milestone → client approves → Nomba transfer fires automatically
5. Repeat per milestone until project COMPLETED

### Error Format
All errors return:
\`\`\`json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "field": "fieldName (optional)"
  }
}
\`\`\`
      `,
    contact: { name: 'MilePay Team', email: 'chukwuemekaazu97@gmail.com' },
    },
    servers: [
      { url: 'http://localhost:3000/v1', description: 'Local Development' },
      { url: 'https://milepay-drab.vercel.app/v1', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token from /auth/login or /auth/register',
        },
      },
      schemas: {
        ApiSuccess: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            data: { type: 'object' },
            message: { type: 'string' },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: 'Email is required' },
                field: { type: 'string', example: 'email' },
              },
            },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['provider', 'client', 'admin'] },
            email_verified: { type: 'boolean' },
            onboarding_complete: { type: 'boolean' },
          },
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string' },
            total_amount: { type: 'number' },
            currency: { type: 'string', example: 'NGN' },
            state: {
              type: 'string',
              enum: ['DRAFT', 'PENDING_ACCEPTANCE', 'PENDING_PAYMENT', 'PARTIALLY_PAID', 'ACTIVE', 'COMPLETED', 'DISPUTED', 'CANCELLED', 'REFUNDED'],
            },
            share_url: { type: 'string' },
            virtual_account_number: { type: 'string' },
            virtual_account_bank: { type: 'string' },
            amount_paid: { type: 'number' },
            overpayment_amount: { type: 'number' },
          },
        },
        Milestone: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            title: { type: 'string' },
            description: { type: 'string' },
            deliverable: { type: 'string' },
            amount: { type: 'number' },
            order_index: { type: 'integer' },
            state: {
              type: 'string',
              enum: ['LOCKED', 'IN_PROGRESS', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'APPROVED_PENDING_TRANSFER', 'PAID', 'DISPUTED', 'REFUNDED'],
            },
            delivery_note: { type: 'string', nullable: true },
            auto_approve_at: { type: 'string', format: 'date-time', nullable: true },
            paid_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        VirtualAccount: {
          type: 'object',
          description: 'Nomba virtual account for client to pay into',
          properties: {
            accountNumber: { type: 'string', example: '0123456789' },
            bankName: { type: 'string', example: 'Nomba Microfinance Bank' },
            accountName: { type: 'string', example: 'MilePay - Brand Identity Package' },
            amount: { type: 'number', example: 120000 },
            currency: { type: 'string', example: 'NGN' },
          },
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Registration, login, email verification, password reset' },
      { name: 'Onboarding', description: 'Multi-step onboarding for providers and clients' },
      { name: 'Projects', description: 'Project creation, acceptance, state management' },
      { name: 'Milestones', description: 'Submit, approve, dispute milestone deliverables' },
      { name: 'Payments', description: 'Inbound payment reconciliation and history' },
      { name: 'Webhooks', description: 'Nomba webhook receiver (not for frontend use)' },
      { name: 'Notifications', description: 'In-app notification management' },
      { name: 'Admin', description: 'Admin-only — disputes, users, transactions' },
    ],
  },
  apis: ['./src/controllers/*.ts', './src/routes/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);