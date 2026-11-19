import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DATABASE, Database } from '../../db/database';
import { Page } from '../../common/http';

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * In-app notifications (inbox). Push/SMS/WhatsApp delivery is added later behind provider
 * adapters (SYSTEM_ARCHITECTURE §7); callers will not change.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async notify(db: Database, userIds: Iterable<string>, input: NotificationInput): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    await db
      .insertInto('notifications')
      .values(
        unique.map((userId) => ({
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data ? JSON.stringify(input.data) : null,
        })),
      )
      .execute();
  }

  async listForUser(userId: string, page: number, pageSize: number, unreadOnly: boolean) {
    let q = this.db.selectFrom('notifications').where('userId', '=', userId);
    if (unreadOnly) q = q.where('readAt', 'is', null);
    const [items, total, unread] = await Promise.all([
      q
        .selectAll()
        .orderBy('createdAt', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      this.db
        .selectFrom('notifications')
        .where('userId', '=', userId)
        .where('readAt', 'is', null)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow(),
    ]);
    return {
      page: new Page(
        items.map(({ userId: _u, ...n }) => n),
        { page, pageSize, total: Number(total.n) },
      ),
      unread: Number(unread.n),
    };
  }

  async markRead(userId: string, ids: string[] | 'all'): Promise<number> {
    let q = this.db
      .updateTable('notifications')
      .set({ readAt: sql<Date>`now()` })
      .where('userId', '=', userId)
      .where('readAt', 'is', null);
    if (ids !== 'all') q = q.where('id', 'in', ids);
    const res = await q.executeTakeFirst();
    return Number(res.numUpdatedRows);
  }
}
