import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import type { PageMeta } from '@cablenet/contracts';
import { AppError, isPgError, PG } from './errors';
import { requestContext } from './request-context';

/** Return from a list handler to produce `{ data: items, meta }`. */
export class Page<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}
}

/** Wraps every successful response in the standard `{ data, meta? }` envelope. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body: unknown) => {
        if (body instanceof StreamableFile) return body; // file downloads are not enveloped
        if (body instanceof Page) return { data: body.items, meta: body.meta };
        return { data: body ?? null };
      }),
    );
  }
}

interface ErrorBody {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function fromPgError(err: { code?: string; constraint?: string; detail?: string }): ErrorBody | null {
  switch (err.code) {
    case PG.UNIQUE_VIOLATION:
      return { status: 409, code: 'DUPLICATE', message: 'A record with the same unique value already exists', details: { constraint: err.constraint } };
    case PG.EXCLUSION_VIOLATION:
      return { status: 409, code: 'OVERLAPPING_PERIOD', message: 'Conflicts with an existing record for an overlapping period', details: { constraint: err.constraint } };
    case PG.FOREIGN_KEY_VIOLATION:
      return { status: 422, code: 'REFERENCE_NOT_FOUND', message: 'A referenced record does not exist', details: { constraint: err.constraint } };
    case PG.CHECK_VIOLATION:
      return { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'Value violates a data rule', details: { constraint: err.constraint } };
    case PG.RESTRICT_VIOLATION:
      return { status: 409, code: 'IMMUTABLE_RECORD', message: 'This record cannot be changed or deleted' };
    default:
      return null;
  }
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = requestContext.get()?.requestId;
    let body: ErrorBody;

    if (exception instanceof AppError) {
      body = { status: exception.status, code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof ThrottlerException) {
      body = { status: 429, code: 'RATE_LIMITED', message: 'Too many requests, please slow down' };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      body = {
        status,
        code: status === 404 ? 'ROUTE_NOT_FOUND' : (HttpStatus[status] ?? 'HTTP_ERROR'),
        message: exception.message,
      };
    } else if (isPgError(exception) && fromPgError(exception)) {
      body = fromPgError(exception)!;
    } else {
      this.logger.error({ err: exception, path: req.url }, 'Unhandled error');
      body = { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
    }

    if (exception instanceof AppError && body.status >= 500) {
      this.logger.error({ err: exception, path: req.url }, body.message);
    }

    res.status(body.status).json({
      error: { code: body.code, message: body.message, details: body.details, requestId },
    });
  }
}
