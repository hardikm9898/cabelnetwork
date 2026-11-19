import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  isSettingKey,
  SETTINGS_DEFAULTS,
  SETTINGS_SCHEMAS,
  SettingKey,
  SettingValue,
} from '@cablenet/contracts';
import { DATABASE, Database } from '../../db/database';
import { AppError, notFound } from '../../common/errors';
import { AuditService } from './audit.service';

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async get<K extends SettingKey>(key: K, db: Database = this.db): Promise<SettingValue<K>> {
    const row = await db.selectFrom('businessSettings').select('value').where('key', '=', key).executeTakeFirst();
    if (!row) return SETTINGS_DEFAULTS[key];
    const parsed = SETTINGS_SCHEMAS[key].safeParse(row.value);
    // A stored value that no longer matches its schema falls back to the default (and is visible in GET /settings).
    return (parsed.success ? parsed.data : SETTINGS_DEFAULTS[key]) as SettingValue<K>;
  }

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.db.selectFrom('businessSettings').select(['key', 'value']).execute();
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(SETTINGS_SCHEMAS) as SettingKey[]) {
      out[key] = stored.has(key) ? stored.get(key) : SETTINGS_DEFAULTS[key];
    }
    return out;
  }

  async set(key: string, value: unknown, actorId: string): Promise<unknown> {
    if (!isSettingKey(key)) throw notFound('SETTING_NOT_FOUND', `Unknown setting "${key}"`);
    const parsed = SETTINGS_SCHEMAS[key].safeParse(value);
    if (!parsed.success) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        'Invalid setting value',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return this.db.transaction().execute(async (trx) => {
      const before = await this.get(key, trx);
      await trx
        .insertInto('businessSettings')
        .values({ key, value: JSON.stringify(parsed.data), updatedBy: actorId })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({
            value: JSON.stringify(parsed.data),
            updatedBy: actorId,
            updatedAt: sql<Date>`now()`,
          }),
        )
        .execute();
      await this.audit.record(trx, { action: 'settings.update', entityType: 'setting', entityId: key, before, after: parsed.data });
      return parsed.data;
    });
  }
}
