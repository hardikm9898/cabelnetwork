import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/env';
import { createDatabase, Database, DATABASE } from '../../db/database';
import { AuditService } from './audit.service';
import { NotificationsService } from './notifications.service';
import { SettingsService } from './settings.service';

/**
 * Process-wide infrastructure: database handle, audit trail, in-app notifications and
 * business settings. Global so feature modules can inject these without re-importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => createDatabase(cfg.DATABASE_URL, cfg.DATABASE_POOL_MAX),
    },
    AuditService,
    NotificationsService,
    SettingsService,
  ],
  exports: [DATABASE, AuditService, NotificationsService, SettingsService],
})
export class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
