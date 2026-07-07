import { Response } from 'express';
import { ApiSuccess, ApiError } from '../types';

export const sendSuccess = <T>(res: Response, data: T, message?: string, statusCode = 200): void => {
  const response: ApiSuccess<T> = { success: true, data, ...(message && { message }) };
  res.status(statusCode).json(response);
};

export const sendSuccessEmailVerifyPage = <T>(res: Response, data: T, message?: string, statusCode = 200): void => {
  const frontendSignInUrl = "https://milepay-nomba.vercel.app/login"
  const response: ApiSuccess<T> = { success: true, data, ...(message && { message }) };
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
        <a href="${frontendSignInUrl}/login">
          Go back to Login
        </a>
      </body>
    </html>
  `);
};


export const sendError = (
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  field?: string,
  details?: Record<string, unknown>
): void => {
  const response: ApiError = {
    success: false,
    error: { code, message, ...(field && { field }), ...(details && { details }) },
  };
  res.status(statusCode).json(response);
};

// ─── Custom Error Classes ─────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public field?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field?: string) {
    super(400, 'VALIDATION_ERROR', message, field);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'STATE_CONFLICT', message);
  }
}
