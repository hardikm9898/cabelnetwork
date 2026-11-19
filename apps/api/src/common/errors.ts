/**
 * Application error with a stable machine-readable `code`. Thrown by services; the global
 * exception filter renders it as `{ error: { code, message, details, requestId } }`.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (code: string, message: string, details?: unknown) =>
  new AppError(401, code, message, details);
export const forbidden = (code: string, message: string, details?: unknown) =>
  new AppError(403, code, message, details);
export const notFound = (code: string, message: string, details?: unknown) =>
  new AppError(404, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** PostgreSQL error helpers (node-postgres DatabaseError shape). */
export interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

export function isPgError(err: unknown, code?: string): err is PgError {
  const c = (err as PgError | null)?.code;
  return typeof c === 'string' && c.length === 5 && (code === undefined || c === code);
}

export const PG = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  RESTRICT_VIOLATION: '23001',
} as const;
