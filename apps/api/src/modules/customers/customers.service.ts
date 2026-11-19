import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateCustomerRequest,
  ListCustomersQuery,
  ReplaceConnectionRequest,
  UpdateCustomerRequest,
} from '@cablenet/contracts';
import { businessDateOf, canReadAllCustomers, cleanText, normalizeIndianMobile } from '@cablenet/domain';
import { DATABASE, Database } from '../../db/database';
import type { CustomerStatusDb } from '../../db/schema';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { Page } from '../../common/http';
import type { AuthUser } from '../../common/request-context';
import { AuditService } from '../core/audit.service';
import { SettingsService } from '../core/settings.service';
import { AssignmentsService } from '../assignments/assignments.service';
import { CustomerAccessService } from './customer-access.service';
import { SubscriptionsService } from '../finance/subscriptions.service';

export interface CustomerWarning {
  code: 'INVALID_MOBILE' | 'INVALID_ALT_MOBILE' | 'DUPLICATE_MOBILE' | 'STB_PREVIOUSLY_USED' | 'UNASSIGNED';
  message: string;
  customers?: { id: string; customerCode: string; name: string }[];
}

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly assignments: AssignmentsService,
    private readonly access: CustomerAccessService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(query: ListCustomersQuery, user: AuthUser) {
    let q = this.db
      .selectFrom('customers as c')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .leftJoin('areas as ar', 'ar.id', 's.areaId')
      .leftJoin('customerCurrentAgent as ca', 'ca.customerId', 'c.id')
      .leftJoin('users as au', 'au.id', 'ca.agentId')
      .leftJoin('customerBalances as b', 'b.customerId', 'c.id');

    if (!canReadAllCustomers(user.role)) q = q.where('ca.agentId', '=', user.id);
    if (query.societyId) q = q.where('c.societyId', '=', query.societyId);
    if (query.areaId) q = q.where('s.areaId', '=', query.areaId);
    if (query.agentId) q = q.where('ca.agentId', '=', query.agentId);
    if (query.status) q = q.where('c.status', '=', query.status);
    if (query.balance === 'OUTSTANDING') q = q.where('b.balance', '>', '0');
    if (query.balance === 'ADVANCE') q = q.where('b.balance', '<', '0');
    if (query.balance === 'SETTLED') q = q.where(sql<boolean>`coalesce(b.balance, 0) = 0`);
    if (query.minOutstanding) q = q.where(sql<boolean>`coalesce(b.outstanding, 0) >= ${query.minOutstanding}::numeric`);
    if (query.q) {
      const term = escapeLike(query.q);
      const digits = query.q.replace(/\D/g, '');
      q = q.where((eb) =>
        eb.or([
          eb('c.name', 'ilike', `%${term}%`),
          eb('c.customerCode', 'ilike', `${term}%`),
          eb('c.addressLine', 'ilike', `%${term}%`),
          ...(digits.length >= 3
            ? [eb('c.mobile', 'like', `%${digits}%`), eb('c.altMobile', 'like', `%${digits}%`)]
            : []),
          eb.exists(
            eb
              .selectFrom('customerConnections as cc')
              .select('cc.id')
              .whereRef('cc.customerId', '=', 'c.id')
              .where('cc.stbNumber', 'ilike', `%${term}%`),
          ),
        ]),
      );
    }

    const sortMap = {
      name: ['c.name', 'asc'],
      '-name': ['c.name', 'desc'],
      code: ['c.customerCode', 'asc'],
      '-code': ['c.customerCode', 'desc'],
      society: ['s.name', 'asc'],
      '-society': ['s.name', 'desc'],
      createdAt: ['c.createdAt', 'asc'],
      '-createdAt': ['c.createdAt', 'desc'],
      outstanding: [sql`coalesce(b.balance, 0)`, 'asc'],
      '-outstanding': [sql`coalesce(b.balance, 0)`, 'desc'],
    } as const;
    const [col, dir] = sortMap[query.sort];

    const [rows, total] = await Promise.all([
      q
        .select([
          'c.id',
          'c.customerCode',
          'c.name',
          'c.mobile',
          'c.mobileValid',
          'c.altMobile',
          'c.addressLine',
          'c.landmark',
          'c.status',
          'c.collectionDay',
          's.id as societyId',
          's.name as societyName',
          'ar.id as areaId',
          'ar.name as areaName',
          'ca.agentId',
          'au.fullName as agentName',
          'ca.kind as assignmentKind',
          sql<string>`coalesce(b.outstanding, 0)::numeric(12,2)`.as('outstanding'),
          sql<string>`coalesce(b.advance, 0)::numeric(12,2)`.as('advance'),
        ])
        .select((eb) =>
          eb
            .selectFrom('customerConnections as cc')
            .select(sql<string>`string_agg(cc.stb_number, ', ' ORDER BY cc.active_from)`.as('stb'))
            .whereRef('cc.customerId', '=', 'c.id')
            .where('cc.activeTo', 'is', null)
            .as('stbNumbers'),
        )
        .orderBy(col, dir)
        .orderBy('c.id')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      q.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);

    return new Page(rows, { page: query.page, pageSize: query.pageSize, total: Number(total.n) });
  }

  async get(id: string, user: AuthUser) {
    await this.access.assertCanAccess(user, id);
    return this.detail(this.db, id);
  }

  async connections(id: string, user: AuthUser) {
    await this.access.assertCanAccess(user, id);
    return this.db
      .selectFrom('customerConnections')
      .selectAll()
      .where('customerId', '=', id)
      .orderBy('activeFrom', 'desc')
      .orderBy('createdAt', 'desc')
      .execute();
  }

  async assignmentHistory(id: string, user: AuthUser) {
    await this.access.assertCanAccess(user, id);
    return this.assignments.customerHistory(id);
  }

  private async detail(db: Database, id: string) {
    const c = await db
      .selectFrom('customers as c')
      .innerJoin('societies as s', 's.id', 'c.societyId')
      .leftJoin('areas as ar', 'ar.id', 's.areaId')
      .selectAll('c')
      .select(['s.name as societyName', 's.areaId', 'ar.name as areaName'])
      .where('c.id', '=', id)
      .executeTakeFirst();
    if (!c) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');

    const [current, primary, connections] = await Promise.all([
      db
        .selectFrom('customerCurrentAgent as ca')
        .innerJoin('users as u', 'u.id', 'ca.agentId')
        .innerJoin('agentProfiles as a', 'a.userId', 'ca.agentId')
        .select(['ca.agentId', 'u.fullName as agentName', 'a.agentCode', 'ca.kind', 'ca.source', 'ca.tempReassignmentId'])
        .where('ca.customerId', '=', id)
        .executeTakeFirst(),
      db
        .selectFrom('customerPrimaryAgent as p')
        .innerJoin('users as u', 'u.id', 'p.agentId')
        .innerJoin('agentProfiles as a', 'a.userId', 'p.agentId')
        .select(['p.agentId', 'u.fullName as agentName', 'a.agentCode', 'p.source'])
        .where('p.customerId', '=', id)
        .executeTakeFirst(),
      db
        .selectFrom('customerConnections')
        .select(['id', 'stbNumber', 'mqNumber', 'activeFrom'])
        .where('customerId', '=', id)
        .where('activeTo', 'is', null)
        .orderBy('activeFrom')
        .execute(),
    ]);

    const { importBatchId, ...customer } = c;
    return {
      ...customer,
      /** Came from the Excel import (has a read-only "Excel history"). */
      imported: importBatchId !== null,
      society: { id: c.societyId, name: c.societyName },
      area: c.areaId ? { id: c.areaId, name: c.areaName } : null,
      currentAgent: current ?? null,
      primaryAgent: primary ?? null,
      activeConnections: connections,
    };
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async create(input: CreateCustomerRequest, actor: AuthUser) {
    const code = input.customerCode.trim();
    const mobile = normalizeIndianMobile(input.mobile);
    const altMobile = normalizeIndianMobile(input.altMobile);
    const stb = input.stbNumber?.trim().toUpperCase() || null;

    return this.db.transaction().execute(async (trx) => {
      await this.assertSocietyUsable(trx, input.societyId);
      const dup = await trx
        .selectFrom('customers')
        .select('id')
        .where(sql<boolean>`lower(customer_code) = lower(${code})`)
        .executeTakeFirst();
      if (dup) throw conflict('CUSTOMER_CODE_EXISTS', `Customer ID ${code} already exists`);

      const warnings = [
        ...(await this.contactWarnings(trx, mobile, altMobile, null)),
        ...(stb ? await this.stbWarnings(trx, stb, null) : []),
      ];
      this.requireAcknowledgement(warnings, input.acknowledgeWarnings);

      const created = await trx
        .insertInto('customers')
        .values({
          customerCode: code,
          name: cleanText(input.name),
          mobile: mobile?.normalized ?? null,
          mobileValid: mobile ? mobile.valid : true,
          altMobile: altMobile?.normalized ?? null,
          addressLine: cleanText(input.addressLine),
          landmark: input.landmark ?? null,
          societyId: input.societyId,
          latitude: input.latitude?.toString() ?? null,
          longitude: input.longitude?.toString() ?? null,
          collectionDay: input.collectionDay ?? null,
          paymentPreferenceMonths: input.paymentPreferenceMonths ?? null,
          notes: input.notes ?? null,
          createdBy: actor.id,
          updatedBy: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (stb) {
        await trx
          .insertInto('customerConnections')
          .values({
            customerId: created.id,
            stbNumber: stb,
            mqNumber: input.mqNumber?.trim() || null,
            activeFrom: businessDateOf(new Date()),
            reason: 'Initial connection',
            createdBy: actor.id,
          })
          .execute();
      }

      const changes = input.agentId
        ? await this.assignments.assignPermanent(trx, [created.id], input.agentId, actor.id, 'Assigned at customer creation')
        : await this.assignments.applyAreaDefault(trx, [created.id], actor.id, 'Area default at customer creation');
      await this.assignments.afterPermanentChanges(trx, changes, 'New customer', 'assignment.initial');
      if (changes.length === 0) {
        warnings.push({ code: 'UNASSIGNED', message: 'No agent is assigned: the society has no area owner yet' });
      }

      const detail = await this.detail(trx, created.id);
      await this.audit.record(trx, { action: 'customer.create', entityType: 'customer', entityId: created.id, after: detail });
      return { customer: detail, warnings };
    });
  }

  async update(id: string, input: UpdateCustomerRequest, actor: AuthUser) {
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('customers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');

      const patch: Record<string, unknown> = {};
      const warnings: CustomerWarning[] = [];

      if (input.mobile !== undefined || input.altMobile !== undefined) {
        const mobile = input.mobile !== undefined ? normalizeIndianMobile(input.mobile) : normalizeIndianMobile(before.mobile);
        const alt = input.altMobile !== undefined ? normalizeIndianMobile(input.altMobile) : normalizeIndianMobile(before.altMobile);
        const changedMobile = input.mobile !== undefined && (mobile?.normalized ?? null) !== before.mobile;
        const changedAlt = input.altMobile !== undefined && (alt?.normalized ?? null) !== before.altMobile;
        warnings.push(...(await this.contactWarnings(trx, changedMobile ? mobile : null, changedAlt ? alt : null, id)));
        if (input.mobile !== undefined) {
          patch.mobile = mobile?.normalized ?? null;
          patch.mobileValid = mobile ? mobile.valid : true;
        }
        if (input.altMobile !== undefined) patch.altMobile = alt?.normalized ?? null;
      }
      this.requireAcknowledgement(warnings, input.acknowledgeWarnings);

      if (input.name !== undefined) patch.name = cleanText(input.name);
      if (input.addressLine !== undefined) patch.addressLine = cleanText(input.addressLine);
      if (input.landmark !== undefined) patch.landmark = input.landmark;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.collectionDay !== undefined) patch.collectionDay = input.collectionDay;
      if (input.paymentPreferenceMonths !== undefined) patch.paymentPreferenceMonths = input.paymentPreferenceMonths;
      if (input.latitude !== undefined) patch.latitude = input.latitude?.toString() ?? null;
      if (input.longitude !== undefined) patch.longitude = input.longitude?.toString() ?? null;
      const societyChanged = input.societyId !== undefined && input.societyId !== before.societyId;
      if (societyChanged) {
        await this.assertSocietyUsable(trx, input.societyId!);
        patch.societyId = input.societyId;
      }

      const changedKeys = Object.keys(patch).filter(
        (k) => JSON.stringify(patch[k]) !== JSON.stringify((before as Record<string, unknown>)[k]),
      );
      if (changedKeys.length === 0) return { customer: await this.detail(trx, id), warnings };

      await trx
        .updateTable('customers')
        .set({ ...patch, updatedBy: actor.id })
        .where('id', '=', id)
        .execute();

      if (societyChanged) {
        const changes = await this.assignments.applyAreaDefault(trx, [id], actor.id, 'Customer moved to another society');
        await this.assignments.afterPermanentChanges(trx, changes, 'Customer moved to another society', 'assignment.area_default');
      }

      await this.audit.record(trx, {
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        before: Object.fromEntries(changedKeys.map((k) => [k, (before as Record<string, unknown>)[k]])),
        after: Object.fromEntries(changedKeys.map((k) => [k, patch[k]])),
        reason: input.reason ?? null,
      });
      return { customer: await this.detail(trx, id), warnings };
    });
  }

  async changeStatus(id: string, action: 'deactivate' | 'reactivate', reason: string, actor: AuthUser) {
    const transitions: Record<typeof action, { from: CustomerStatusDb[]; to: CustomerStatusDb }> = {
      deactivate: { from: ['ACTIVE', 'SUSPENDED'], to: 'INACTIVE' },
      reactivate: { from: ['INACTIVE'], to: 'ACTIVE' },
    };
    const t = transitions[action];
    return this.db.transaction().execute(async (trx) => {
      const before = await trx.selectFrom('customers').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!before) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
      if (!t.from.includes(before.status)) {
        throw conflict('INVALID_STATUS_TRANSITION', `Cannot ${action} a customer whose status is ${before.status}`);
      }
      await trx
        .updateTable('customers')
        .set({
          status: t.to,
          statusReason: reason,
          deactivatedAt: t.to === 'INACTIVE' ? sql<Date>`now()` : null,
          updatedBy: actor.id,
        })
        .where('id', '=', id)
        .execute();
      // Billing stops with the service; dues stay collectable. Reactivation needs a new subscription.
      if (t.to === 'INACTIVE') await this.subscriptions.endLiveForCustomer(trx, id, `Customer deactivated: ${reason}`, actor);
      await this.audit.record(trx, {
        action: `customer.${action}`,
        entityType: 'customer',
        entityId: id,
        before: { status: before.status },
        after: { status: t.to },
        reason,
      });
      return this.detail(trx, id);
    });
  }

  /** Set-top box swap: closes the active connection(s) and opens the new one. History kept. */
  async replaceConnection(id: string, input: ReplaceConnectionRequest, actor: AuthUser) {
    const stb = input.stbNumber.trim().toUpperCase();
    return this.db.transaction().execute(async (trx) => {
      const exists = await trx.selectFrom('customers').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      if (!exists) throw notFound('CUSTOMER_NOT_FOUND', 'Customer not found');
      const active = await trx
        .selectFrom('customerConnections')
        .selectAll()
        .where('customerId', '=', id)
        .where('activeTo', 'is', null)
        .execute();
      if (active.some((c) => c.activeFrom > input.effectiveDate)) {
        throw unprocessable('EFFECTIVE_DATE_TOO_EARLY', 'Effective date is before the current box was installed');
      }
      const inUse = await trx
        .selectFrom('customerConnections')
        .select('customerId')
        .where(sql<boolean>`upper(stb_number) = ${stb}`)
        .where('activeTo', 'is', null)
        .executeTakeFirst();
      if (inUse) throw conflict('STB_IN_USE', `STB ${stb} is already active on a customer`);

      if (active.length > 0) {
        await trx
          .updateTable('customerConnections')
          .set({ activeTo: input.effectiveDate })
          .where('customerId', '=', id)
          .where('activeTo', 'is', null)
          .execute();
      }
      const created = await trx
        .insertInto('customerConnections')
        .values({
          customerId: id,
          stbNumber: stb,
          mqNumber: input.mqNumber?.trim() || null,
          activeFrom: input.effectiveDate,
          reason: input.reason,
          createdBy: actor.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        action: 'customer.connection_replaced',
        entityType: 'customer',
        entityId: id,
        before: active.map((c) => ({ stbNumber: c.stbNumber, mqNumber: c.mqNumber })),
        after: { stbNumber: created.stbNumber, mqNumber: created.mqNumber },
        reason: input.reason,
      });
      return created;
    });
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  private async assertSocietyUsable(db: Database, societyId: string): Promise<void> {
    const society = await db.selectFrom('societies').select(['status']).where('id', '=', societyId).executeTakeFirst();
    if (!society) throw unprocessable('SOCIETY_NOT_FOUND', 'Society not found');
    if (society.status !== 'ACTIVE') throw unprocessable('SOCIETY_INACTIVE', 'Society is inactive');
  }

  private requireAcknowledgement(warnings: CustomerWarning[], acknowledged: boolean): void {
    if (warnings.length > 0 && !acknowledged) {
      throw conflict('CONFIRMATION_REQUIRED', 'Please review the warnings and confirm', { warnings });
    }
  }

  private async contactWarnings(
    db: Database,
    mobile: ReturnType<typeof normalizeIndianMobile>,
    alt: ReturnType<typeof normalizeIndianMobile>,
    excludeId: string | null,
  ): Promise<CustomerWarning[]> {
    const warnings: CustomerWarning[] = [];
    if (mobile && !mobile.valid) warnings.push({ code: 'INVALID_MOBILE', message: `Mobile ${mobile.normalized} is not a valid 10-digit Indian mobile number` });
    if (alt && !alt.valid) warnings.push({ code: 'INVALID_ALT_MOBILE', message: `Alternate mobile ${alt.normalized} is not a valid 10-digit Indian mobile number` });

    const rule = (await this.settings.get('customers.duplicateRules', db)).mobile;
    const numbers = [mobile?.normalized, alt?.normalized].filter((n): n is string => !!n);
    if (rule === 'off' || numbers.length === 0) return warnings;

    let q = db
      .selectFrom('customers')
      .select(['id', 'customerCode', 'name'])
      .where((eb) => eb.or([eb('mobile', 'in', numbers), eb('altMobile', 'in', numbers)]));
    if (excludeId) q = q.where('id', '!=', excludeId);
    const matches = await q.limit(20).execute();
    if (matches.length > 0) {
      if (rule === 'block') {
        throw conflict('DUPLICATE_MOBILE', 'This mobile number is already used by another customer', { customers: matches });
      }
      warnings.push({ code: 'DUPLICATE_MOBILE', message: 'This mobile number is already used by another customer', customers: matches });
    }
    return warnings;
  }

  private async stbWarnings(db: Database, stb: string, excludeId: string | null): Promise<CustomerWarning[]> {
    let q = db
      .selectFrom('customerConnections as cc')
      .innerJoin('customers as c', 'c.id', 'cc.customerId')
      .select(['c.id', 'c.customerCode', 'c.name', 'cc.activeTo'])
      .where(sql<boolean>`upper(cc.stb_number) = ${stb}`);
    if (excludeId) q = q.where('c.id', '!=', excludeId);
    const matches = await q.execute();
    if (matches.some((m) => m.activeTo === null)) {
      throw conflict('STB_IN_USE', `STB ${stb} is already active on another customer`, {
        customers: matches.filter((m) => m.activeTo === null).map(({ activeTo: _a, ...c }) => c),
      });
    }
    if (matches.length === 0) return [];
    const rule = (await this.settings.get('customers.duplicateRules', db)).stb;
    const customers = matches.map(({ activeTo: _a, ...c }) => c);
    if (rule === 'block') throw conflict('STB_PREVIOUSLY_USED', `STB ${stb} was previously used by another customer`, { customers });
    return [{ code: 'STB_PREVIOUSLY_USED', message: `STB ${stb} was previously used by another customer`, customers }];
  }
}
