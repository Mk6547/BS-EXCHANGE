import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AndarBaharService } from './andarbahar.service';
import { AndarBaharController } from './andarbahar.controller';
import { AdminAndarBaharController } from './admin-andarbahar.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule], inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ secret: c.getOrThrow<string>('JWT_SECRET'), signOptions: { expiresIn: c.get<string>('JWT_TTL') ?? '7d' } }),
    }),
  ],
  controllers: [AndarBaharController, AdminAndarBaharController],
  providers: [AndarBaharService, LedgerService, AuditService],
  exports: [AndarBaharService],
})
export class AndarBaharModule {}
