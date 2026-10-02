import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TeenPattiService } from './teenpatti.service';
import { TeenPattiController } from './teenpatti.controller';
import { AdminTeenPattiController } from './admin-teenpatti.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

/** Teen Patti 20-20. Shares the wallet with sports, the wheel and InOut. */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_TTL') ?? '7d' },
      }),
    }),
  ],
  controllers: [TeenPattiController, AdminTeenPattiController],
  providers: [TeenPattiService, LedgerService, AuditService],
  exports: [TeenPattiService],
})
export class TeenPattiModule {}
