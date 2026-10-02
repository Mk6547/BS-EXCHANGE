import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminConfigController } from './admin-config.controller';
import { ContentController } from './content.controller';
import { PaymentsController } from './payments.controller';
import { AuditService } from './audit.service';
import { LedgerService } from './ledger.service';

@Module({
  controllers: [ContentController, PaymentsController, AdminController, AdminConfigController],
  providers: [LedgerService, AuditService],
  exports: [LedgerService, AuditService],
})
export class PlatformModule {}
