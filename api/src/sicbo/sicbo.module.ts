import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SicBoService } from './sicbo.service';
import { SicBoController } from './sicbo.controller';
import { AdminSicBoController } from './admin-sicbo.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

@Module({
  imports: [JwtModule.registerAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory: (c: ConfigService) => ({ secret: c.getOrThrow<string>('JWT_SECRET'), signOptions: { expiresIn: c.get<string>('JWT_TTL') ?? '7d' } }) })],
  controllers: [SicBoController, AdminSicBoController],
  providers: [SicBoService, LedgerService, AuditService],
  exports: [SicBoService],
})
export class SicBoModule {}
