import { BadRequestException, Controller, Get, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OddsFeedService } from './odds-feed.service';
import { TheOddsApiAdapter } from './theoddsapi.adapter';
import { ScoresResultsService } from './scores-results.service';
import { PulseScoreAdapter } from './pulsescore.adapter';

/**
 * Cron entry point for the odds feed.
 *
 * On shared cPanel hosting Passenger puts the Node process to sleep when no
 * request arrives, which stops any in-process timer. A cPanel cron job hitting
 * this URL keeps the feed moving whether or not the process was awake:
 *
 *   * * * * * curl -s "https://api.bsexchange.live/sports-cron/sync?token=YOUR_TOKEN" >/dev/null
 *
 * Put the same value in .env as SPORTS_CRON_TOKEN. Without it the route is off.
 */
@Controller('sports-cron')
export class FeedCronController {
  constructor(
    private readonly ds: DataSource,
    private readonly feed: OddsFeedService,
    private readonly adapter: TheOddsApiAdapter,
    private readonly scores: ScoresResultsService,
    private readonly pulse: PulseScoreAdapter,
    private readonly config: ConfigService,
  ) {}

  @Get('sync')
  async sync(@Query('token') token: string) {
    const expected = this.config.get<string>('SPORTS_CRON_TOKEN');
    if (!expected) throw new BadRequestException({ message: 'SPORTS_CRON_TOKEN is not set.' });
    if (token !== expected) throw new UnauthorizedException('Bad token.');

    const providers = await this.ds.query(
      `SELECT id, code, adapter FROM odds_provider WHERE enabled = 1 AND kind <> 'manual'`,
    );
    const results: any[] = [];
    // PulseScore runs once per cron (it manages its own sports internally).
    try { results.push({ code: 'pulsescore', ok: true, ...(await this.pulse.sync()) }); }
    catch (e: any) { results.push({ code: 'pulsescore', ok: false, error: String(e?.message ?? e).slice(0, 200) }); }
    for (const p of providers) {
      try {
        if (p.adapter === 'theoddsapi') {
          // The dedicated pipeline: discover sports, then events + odds.
          const sports = await this.adapter.syncSports(p.id);
          const odds = await this.adapter.syncEventsAndOdds(p.id);
          const scores = await this.scores.syncScoresAndSettle(p.id, 1);
          const reconcile = await this.adapter.reconcile(p.id);
          results.push({ code: p.code, ok: true, sports, odds, scores, reconcile });
        } else {
          results.push({ code: p.code, ...(await this.feed.sync(p.id)) });
        }
      } catch (err: any) {
        results.push({ code: p.code, ok: false, error: String(err?.message ?? err).slice(0, 200) });
      }
    }
    return { ran: results.length, results };
  }
}
