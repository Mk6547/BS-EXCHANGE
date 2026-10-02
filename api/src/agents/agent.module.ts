import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AgentService } from './agent.service';
import { WinlossSyncService } from './winloss-sync.service';
import { AgentController } from './agent.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

/**
 * The master / admin / player hierarchy. AgentService is exported so each
 * game's settlement can call recordResult() to attribute win/loss to the
 * player's admin.
 */
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
  controllers: [AgentController],
  providers: [AgentService, WinlossSyncService, LedgerService, AuditService],
  exports: [AgentService],
})
export class AgentModule {}
