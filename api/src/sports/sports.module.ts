import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SportsService } from './sports.service';
import { SportsController } from './sports.controller';
import { AdminSportsController } from './admin-sports.controller';
import { OddsFeedService } from './odds-feed.service';
import { TheOddsApiAdapter } from './theoddsapi.adapter';
import { ScoresResultsService } from './scores-results.service';
import { PulseScoreAdapter } from './pulsescore.adapter';
import { FeedCronController } from './feed-cron.controller';
import { LedgerService } from '../platform/ledger.service';
import { AuditService } from '../platform/audit.service';

/**
 * Sports betting. Independent of the InOut casino: the only thing the two
 * share is the wallet and its ledger.
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
  controllers: [SportsController, AdminSportsController, FeedCronController],
  providers: [SportsService, OddsFeedService, TheOddsApiAdapter, ScoresResultsService, PulseScoreAdapter, LedgerService, AuditService],
  exports: [SportsService],
})
export class SportsModule {}
