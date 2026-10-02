import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InoutWebhookService } from './inout-webhook.service';
import { InoutLaunchService } from './inout-launch.service';
import { CreateBonusInput, InoutBonusService } from './inout-bonus.service';
import { InoutIpGuard } from './guards/inout-ip.guard';
import { InoutSignatureGuard } from './guards/inout-signature.guard';
import { InoutExceptionFilter, InoutRejection } from './filters/inout-exception.filter';
import { INOUT_HANDLER_BUDGET_MS, InoutCode } from './inout.constants';
import { InoutRequest, InoutResponse } from './dto/webhook.dto';
import { AdminGuard, JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('integrations/inout')
export class InoutController {
  constructor(
    private readonly webhooks: InoutWebhookService,
    private readonly launch: InoutLaunchService,
    private readonly bonuses: InoutBonusService,
    private readonly ds: DataSource,
  ) {}

  /**
   * Liveness check. Safe to expose and to poll: it reveals no configuration and
   * touches the database, so a green answer means the app is genuinely able to
   * serve a webhook rather than merely running.
   *
   * Also the right target for the cPanel keep-alive cron — cheaper than /games,
   * which reaches out to the provider.
   */
  @Get('health')
  async health() {
    let database = 'down';
    try {
      await this.ds.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      webhook: 'POST /integrations/inout/webhook',
      time: new Date().toISOString(),
    };
  }

  /**
   * The single URL given to InOut:
   *   https://api.bsexchange.live/integrations/inout/webhook
   * Handles init, bet, withdraw, rollback and both bonus settlements.
   * Always answers 200 — see InoutExceptionFilter.
   */
  @Post('webhook')
  @HttpCode(200)
  @UseGuards(InoutIpGuard, InoutSignatureGuard)
  @UseFilters(InoutExceptionFilter)
  async webhook(@Body() body: InoutRequest): Promise<InoutResponse> {
    // Temporary: proves whether a webhook reached us at all. Remove with the
    // debug controller once the integration is signed off.
    console.error(`[inout] IN action=${(body as any)?.action ?? '-'}`);

    // The provider gives us 10s. We cut ourselves off earlier so a stuck query
    // returns a clean TEMPORARY_ERROR instead of letting their client time out,
    // which for a bet would trigger an automatic rollback (backend spec 2.51).
    return Promise.race([
      this.webhooks.handle(body),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new InoutRejection(InoutCode.TEMPORARY_ERROR, 'handler budget exceeded')),
          INOUT_HANDLER_BUDGET_MS,
        ).unref(),
      ),
    ]);
  }

  // ------------------------------------------------------------------
  // Platform-side endpoints. Protect these with your normal player JWT
  // guard; the bonus routes need an admin guard on top.
  // ------------------------------------------------------------------

  @Get('games')
  games() {
    return this.launch.listGames();
  }

  /** Games that accept FREEBET grants — for the bonus admin screen. */
  @Get('games/freebet')
  freebetGames() {
    return this.launch.freebetGames();
  }

  /**
   * Frontend spec 7.2 — the client asks us, we ask the provider, the client
   * gets only the final launchUrl. It then renders:
   *   <iframe scrolling="yes" allow="autoplay" allowfullscreen="" src="${launchUrl}">
   */
  @Get('launch')
  @UseGuards(JwtAuthGuard)
  async createLaunch(
    @Req() req: any,
    @Query()
    q: { gameMode: string; currency: string; lang?: string; isDemoPlay?: string; country?: string },
  ) {
    try {
      return { launchUrl: await this.launchFor(req, q) };
    } catch (err: any) {
      // The provider's own wording is more useful than "Internal server error".
      throw new BadGatewayException({
        message: err?.message ?? 'The game could not be started.',
      });
    }
  }

  private async launchFor(req: any, q: any): Promise<string> {
    const { launchUrl } = await this.launch.createLaunchUrl({
      // From the verified token, never from the query string — otherwise any
      // signed-in player could open a session as someone else.
      userId: req.user.id,
      gameMode: q.gameMode,
      currency: q.currency,
      lang: q.lang,
      isDemoPlay: q.isDemoPlay === 'true',
      userCountryCode: resolveCountry(req, q.country),
    });
    return launchUrl;
  }

  @Post('bonuses')
  @UseGuards(JwtAuthGuard, AdminGuard)
  createBonus(@Body() body: CreateBonusInput & { hideFromStat?: boolean }) {
    const { hideFromStat, ...input } = body;
    return this.bonuses.create(input, { hideFromStat });
  }

  @Get('bonuses')
  @UseGuards(JwtAuthGuard, AdminGuard)
  listBonuses(@Query() q: any) {
    return this.bonuses.list(q);
  }

  @Get('bonuses/:bonusId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  viewBonus(@Param('bonusId') bonusId: string) {
    return this.bonuses.view(bonusId);
  }

  @Delete('bonuses/:bonusId')
  @UseGuards(JwtAuthGuard, AdminGuard)
  cancelBonus(@Param('bonusId') bonusId: string) {
    return this.bonuses.cancel(bonusId);
  }
}

/**
 * Frontend spec 7.3 — userCountryCode must be where the player actually is.
 *
 * Sources in order of trustworthiness: Cloudflare's edge header if the site is
 * proxied, then the country recorded on the account, then whatever the client
 * claimed, then a configured default.
 *
 * The client-supplied value is last because a player can set it to anything;
 * it exists so launches still work before a geo source is wired up. Once
 * bsexchange sits behind Cloudflare, or a MaxMind lookup is added, drop the
 * query fallback — an accurate country is what keeps the provider serving a
 * domain that is actually reachable for that player.
 */
function resolveCountry(req: any, claimed?: string): string {
  const header = req.headers?.['cf-ipcountry'];
  const candidate =
    (typeof header === 'string' && header !== 'XX' ? header : null) ??
    req.user?.countryCode ??
    claimed ??
    process.env.DEFAULT_COUNTRY ??
    'PK';
  return String(candidate).trim().toUpperCase();
}