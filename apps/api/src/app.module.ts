import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG, AppConfig } from './config/env';
import { GlobalExceptionFilter, ResponseEnvelopeInterceptor } from './common/http';
import { requestContext } from './common/request-context';
import { CoreModule } from './modules/core/core.module';
import { AuditController, HealthController, NotificationsController, SettingsController } from './modules/core/core.controllers';
import { AuthController } from './modules/auth/auth.controller';
import { AuthGuard, PermissionsGuard } from './modules/auth/auth.guard';
import { AuthService } from './modules/auth/auth.service';
import { AssignmentsController } from './modules/assignments/assignments.controller';
import { AssignmentsService } from './modules/assignments/assignments.service';
import { CustomerAccessService } from './modules/customers/customer-access.service';
import { CustomersController } from './modules/customers/customers.controller';
import { CustomersService } from './modules/customers/customers.service';
import { AreasController, SocietiesController } from './modules/geography/geography.controllers';
import { GeographyService } from './modules/geography/geography.service';
import { AgentsController, UsersController } from './modules/people/people.controllers';
import { PeopleService } from './modules/people/people.service';
import { IdempotencyInterceptor } from './common/idempotency';
import { AlertsService } from './modules/finance/alerts.service';
import { BillingService } from './modules/finance/billing.service';
import { CashService } from './modules/finance/cash.service';
import { CreditsService } from './modules/finance/credits.service';
import {
  BillingController,
  CashController,
  CustomerFinanceController,
  PaymentsController,
  ReconciliationController,
  SubscriptionsController,
} from './modules/finance/finance.controllers';
import { JobsService } from './modules/finance/jobs.service';
import { LedgerQueriesService } from './modules/finance/ledger-queries.service';
import { LedgerService } from './modules/finance/ledger.service';
import { PaymentsService } from './modules/finance/payments.service';
import { ReceiptsService } from './modules/finance/receipts.service';
import { ReconciliationService } from './modules/finance/reconciliation.service';
import { SubscriptionsService } from './modules/finance/subscriptions.service';
import { FieldOpsController } from './modules/fieldops/fieldops.controller';
import { FieldOpsService } from './modules/fieldops/fieldops.service';
import { DashboardService } from './modules/reports/dashboard.service';
import { ReportsController } from './modules/reports/reports.controller';
import { ReportsService } from './modules/reports/reports.service';
import { CollectionsController } from './modules/collections/collections.controller';
import { CollectionsService } from './modules/collections/collections.service';
import { SyncController } from './modules/sync/sync.controller';
import { ImportsController } from './modules/imports/imports.controller';
import { ImportsService } from './modules/imports/imports.service';
import { SyncService } from './modules/sync/sync.service';

/**
 * Root module. Guard order matters: Throttler → Auth (who are you) → Permissions (may you).
 * Providers live in one module: the feature set is small enough that explicit module
 * boundaries would add wiring without adding safety (layering is enforced by folders).
 */
@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: cfg.LOG_LEVEL,
            genReqId: (req) => requestContext.get()?.requestId ?? String(req.headers['x-request-id'] ?? ''),
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'err.detail', 'err.parameters'],
            // Request lines without query strings (searches hold names and mobile digits) and without
            // public receipt tokens, which work like passwords (security review L-6).
            serializers: {
              req: (req: { id?: unknown; method?: string; url?: string }) => ({
                id: req.id,
                method: req.method,
                url: (req.url ?? '').split('?')[0]!.replace(/\/public\/receipts\/[^/]+/, '/public/receipts/***'),
              }),
            },
            autoLogging: { ignore: (req) => req.url === '/api/v1/health' || req.url === '/api/v1/health/ready' },
            transport: cfg.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
          },
        }),
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: cfg.RATE_LIMIT_PER_MINUTE }] }),
        JwtModule.register({
          secret: cfg.JWT_ACCESS_SECRET,
          signOptions: { expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS, algorithm: 'HS256', issuer: 'cablenet' },
          verifyOptions: { algorithms: ['HS256'], issuer: 'cablenet' },
        }),
        { module: CoreModule, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] },
      ],
      controllers: [
        HealthController,
        AuthController,
        UsersController,
        AgentsController,
        AreasController,
        SocietiesController,
        CustomersController,
        AssignmentsController,
        SettingsController,
        NotificationsController,
        AuditController,
        CustomerFinanceController,
        SubscriptionsController,
        BillingController,
        PaymentsController,
        CashController,
        ReconciliationController,
        FieldOpsController,
        ReportsController,
        CollectionsController,
        SyncController,
        ImportsController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        AuthService,
        PeopleService,
        GeographyService,
        AssignmentsService,
        CustomerAccessService,
        CustomersService,
        IdempotencyInterceptor,
        LedgerService,
        LedgerQueriesService,
        AlertsService,
        ReceiptsService,
        SubscriptionsService,
        BillingService,
        PaymentsService,
        CreditsService,
        CashService,
        ReconciliationService,
        JobsService,
        FieldOpsService,
        ReportsService,
        DashboardService,
        CollectionsService,
        SyncService,
        ImportsService,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
      ],
    };
  }
}
