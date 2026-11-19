import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateAreaRequest,
  CreateSocietyRequest,
  UpdateAreaRequest,
  UpdateSocietyRequest,
} from '@cablenet/contracts';
import { cleanText } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import { badRequest, conflict, notFound } from '../../common/errors';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { AssignmentsService } from '../assignments/assignments.service';

@Injectable()
export class GeographyService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly assignments: AssignmentsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Areas
  // ---------------------------------------------------------------------------

  async listAreas() {
    return this.db
      .selectFrom('areas as ar')
      .leftJoin('areaAgentAssignments as aa', (j) => j.onRef('aa.areaId', '=', 'ar.id').on(sql<boolean>`aa.valid_during @> now()`))
      .leftJoin('users as u', 'u.id', 'aa.agentId')
      .selectAll('ar')
      .select(['aa.agentId as ownerAgentId', 'u.fullName as ownerAgentName'])
      .select((eb) => [
        eb.selectFrom('societies as s').select((e) => e.fn.countAll<string>().as('n')).whereRef('s.areaId', '=', 'ar.id').as('societyCount'),
        eb
          .selectFrom('customers as c')
          .innerJoin('societies as s', 's.id', 'c.societyId')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('s.areaId', '=', 'ar.id')
          .as('customerCount'),
      ])
      .orderBy('ar.name')
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, societyCount: Number(r.societyCount ?? 0), customerCount: Number(r.customerCount ?? 0) })));
  }

  async getArea(id: string, db: Database = this.db) {
    const area = await db.selectFrom('areas').selectAll().where('id', '=', id).executeTakeFirst();
    if (!area) throw notFound('AREA_NOT_FOUND', 'Area not found');
    const [owners, societies] = await Promise.all([
      db
        .selectFrom('areaAgentAssignments as aa')
        .innerJoin('users as u', 'u.id', 'aa.agentId')
        .select([
          'aa.id',
          'aa.agentId',
          'u.fullName as agentName',
          sql<Date>`lower(aa.valid_during)`.as('validFrom'),
          sql<Date | null>`upper(aa.valid_during)`.as('validTo'),
          sql<boolean>`aa.valid_during @> now()`.as('isCurrent'),
          'aa.reason',
          'aa.endedReason',
        ])
        .where('aa.areaId', '=', id)
        .orderBy('aa.createdAt', 'desc')
        .execute(),
      db.selectFrom('societies').selectAll().where('areaId', '=', id).orderBy('name').execute(),
    ]);
    return { ...area, currentOwner: owners.find((o) => o.isCurrent) ?? null, ownerHistory: owners, societies };
  }

  async createArea(input: CreateAreaRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.assertAreaNameFree(trx, input.name);
      const area = await trx
        .insertInto('areas')
        .values({ name: cleanText(input.name), description: input.description ?? null, createdBy: actor.id, updatedBy: actor.id })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'area.create', entityType: 'area', entityId: area.id, after: area });
      return area;
    });
  }

  async updateArea(id: string, input: UpdateAreaRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('areas').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('AREA_NOT_FOUND', 'Area not found');
      if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertAreaNameFree(trx, input.name);
      }
      const after = await trx
        .updateTable('areas')
        .set({
          ...(input.name !== undefined && { name: cleanText(input.name) }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.status !== undefined && { status: input.status }),
          updatedBy: actor.id,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'area.update', entityType: 'area', entityId: id, before, after });
      return after;
    });
  }

  // ---------------------------------------------------------------------------
  // Societies
  // ---------------------------------------------------------------------------

  async listSocieties(filter: { areaId?: string }) {
    let q = this.db.selectFrom('societies as s').leftJoin('areas as ar', 'ar.id', 's.areaId');
    if (filter.areaId) q = q.where('s.areaId', '=', filter.areaId);
    return q
      .selectAll('s')
      .select('ar.name as areaName')
      .select((eb) =>
        eb.selectFrom('customers as c').select((e) => e.fn.countAll<string>().as('n')).whereRef('c.societyId', '=', 's.id').as('customerCount'),
      )
      .orderBy('s.name')
      .execute()
      .then((rows) => rows.map((r) => ({ ...r, customerCount: Number(r.customerCount ?? 0) })));
  }

  async getSociety(id: string) {
    const s = await this.db
      .selectFrom('societies as s')
      .leftJoin('areas as ar', 'ar.id', 's.areaId')
      .selectAll('s')
      .select('ar.name as areaName')
      .where('s.id', '=', id)
      .executeTakeFirst();
    if (!s) throw notFound('SOCIETY_NOT_FOUND', 'Society not found');
    return s;
  }

  async createSociety(input: CreateSocietyRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      await this.assertSocietyNameFree(trx, input.name);
      if (input.areaId) await this.getArea(input.areaId, trx);
      const society = await trx
        .insertInto('societies')
        .values({
          name: cleanText(input.name),
          legacyName: input.legacyName ?? null,
          areaId: input.areaId ?? null,
          collectionDay: input.collectionDay ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, { action: 'society.create', entityType: 'society', entityId: society.id, after: society });
      return society;
    });
  }

  /** Moving a society to another area re-points customers that follow the area default. */
  async updateSociety(id: string, input: UpdateSocietyRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('societies').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('SOCIETY_NOT_FOUND', 'Society not found');
      const areaChanged = input.areaId !== undefined && input.areaId !== before.areaId;
      if (areaChanged && !input.reason) {
        throw badRequest('REASON_REQUIRED', 'A reason is required when moving a society to another area');
      }
      if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertSocietyNameFree(trx, input.name);
      }
      if (areaChanged && input.areaId) await this.getArea(input.areaId, trx);

      const after = await trx
        .updateTable('societies')
        .set({
          ...(input.name !== undefined && { name: cleanText(input.name) }),
          ...(input.areaId !== undefined && { areaId: input.areaId }),
          ...(input.collectionDay !== undefined && { collectionDay: input.collectionDay }),
          ...(input.status !== undefined && { status: input.status }),
          updatedBy: actor.id,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      let customersMoved = 0;
      if (areaChanged) {
        const customerIds = await this.assignments.customerIdsInSocieties(trx, [id]);
        const changes = await this.assignments.applyAreaDefault(trx, customerIds, actor.id, input.reason!);
        await this.assignments.afterPermanentChanges(trx, changes, input.reason!, 'assignment.area_default');
        customersMoved = changes.length;
      }
      await this.audit.record(trx, {
        action: 'society.update',
        entityType: 'society',
        entityId: id,
        before,
        after,
        reason: input.reason ?? null,
      });
      return { ...after, customersMoved };
    });
  }

  private async assertAreaNameFree(db: Database, name: string): Promise<void> {
    const taken = await db.selectFrom('areas').select('id').where(sql<boolean>`lower(name) = lower(${cleanText(name)})`).executeTakeFirst();
    if (taken) throw conflict('AREA_NAME_EXISTS', `Area "${name}" already exists`);
  }

  private async assertSocietyNameFree(db: Database, name: string): Promise<void> {
    const taken = await db
      .selectFrom('societies')
      .select('id')
      .where(sql<boolean>`lower(name) = lower(${cleanText(name)})`)
      .executeTakeFirst();
    if (taken) throw conflict('SOCIETY_NAME_EXISTS', `Society "${name}" already exists`);
  }
}
