import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WheelService } from './wheel.service';
import { WheelController } from './wheel.controller';
import { AdminWheelController } from './admin-wheel.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

/** The food wheel. Shares the wallet with sports and InOut, nothing else. */
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
  controllers: [WheelController, AdminWheelController],
  providers: [WheelService, LedgerService, AuditService],
  exports: [WheelService],
})
export class WheelModule {}
