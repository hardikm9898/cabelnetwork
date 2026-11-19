import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { from, lastValueFrom, Observable } from 'rxjs';
import { DATABASE, Database } from '../db/database';
import { badRequest, conflict, unprocessable } from './errors';
import type { AuthUser } from './request-context';

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Exactly-once semantics for financial POSTs (FINANCIAL_LOGIC §1.5). The client sends an
 * `Idempotency-Key` header (a fresh UUID per user action). A retry with the same key and body
 * returns the stored result without executing again; the same key with a different body is
 * rejected; a concurrent duplicate gets 409 until the first finishes. Failed requests release
 * their key so the client can retry.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const key = req.header('idempotency-key');
    if (!key || !KEY_RE.test(key)) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (e.g. a new UUID) with this request');
    }
    const user = req.user!;
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const requestHash = createHash('sha256').update(`${route}\n${JSON.stringify(req.body ?? null)}`).digest('hex');
    return from(this.handle(user.id, key, route, requestHash, next));
  }

  private async handle(userId: string, key: string, route: string, requestHash: string, next: CallHandler): Promise<unknown> {
    const inserted = await this.db
      .insertInto('idempotencyKeys')
      .values({ key, userId, route, requestHash })
      .onConflict((oc) => oc.columns(['userId', 'key']).doNothing())
      .returning('key')
      .executeTakeFirst();

    if (!inserted) {
      const existing = await this.db
        .selectFrom('idempotencyKeys')
        .selectAll()
        .where('userId', '=', userId)
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      if (existing.requestHash !== requestHash) {
        throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      if (existing.status !== 'COMPLETED') {
        throw conflict('IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed');
      }
      return existing.responseBody;
    }

    try {
      const result = await lastValueFrom(next.handle(), { defaultValue: null });
      await this.db
        .updateTable('idempotencyKeys')
        .set({ status: 'COMPLETED', responseStatus: 200, responseBody: JSON.stringify(result ?? null) })
        .where('userId', '=', userId)
        .where('key', '=', key)
        .execute();
      return result;
    } catch (err) {
      await sql`DELETE FROM idempotency_keys WHERE user_id = ${userId} AND key = ${key}`.execute(this.db);
      throw err;
    }
  }
}

/** Marks a POST as idempotent (Idempotency-Key header required). */
export const Idempotent = () =>
  applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique key per user action (e.g. UUID); retries reuse it' }),
  );

