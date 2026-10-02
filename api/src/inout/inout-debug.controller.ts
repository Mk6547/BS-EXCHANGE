import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { INOUT_IP_ALLOWLIST } from './inout.constants';
import { DataSource } from 'typeorm';
import { InoutLaunchService } from './inout-launch.service';
import { subIdToken, subOperatorId } from './util/inout-ids.util';

/**
 * TEMPORARY DIAGNOSTICS — DELETE BEFORE GOING LIVE.
 *
 * The real guards deliberately answer every failure with the same INVALID_TOKEN
 * so a prober learns nothing. That is right in production and useless while
 * setting up, so these two endpoints show what the guards actually saw.
 *
 * They are unauthenticated and they echo back signature material, so they must
 * not exist on a server handling real money.
 */
@Controller('integrations/inout/debug')
export class InoutDebugController {
  constructor(
    private readonly config: ConfigService,
    private readonly launch: InoutLaunchService,
    private readonly ds: DataSource,
  ) {}

  /** Balance for the lobby header. Replace with an authenticated route. */
  @Get('balance')
  async balance(@Query() q: { userId?: string; currency?: string }) {
    const rows = await this.ds.query(
      `SELECT w.balance, w.currency, u.nickname
         FROM wallet w JOIN users u ON u.id = w.user_id
        WHERE w.user_id = ? AND w.currency = ?`,
      [q.userId ?? '1', q.currency ?? 'USD'],
    );
    if (!rows.length) return { found: false };
    return {
      found: true,
      nickname: rows[0].nickname,
      currency: rows[0].currency,
      balance: Number(rows[0].balance).toFixed(2),
    };
  }

  /**
   * Launch a game as any user, with no authentication.
   *
   * This exists only because bsexchange has no login yet, so the real /launch
   * route has nothing to read req.user.id from. It is also how the subId gets
   * registered with the provider, which happens on the first successful launch.
   *
   *   /debug/launch?userId=1&gameMode=chicken-road&currency=USD&country=PK
   */
  @Get('launch')
  async debugLaunch(
    @Query() q: { userId?: string; gameMode?: string; currency?: string; country?: string },
  ) {
    try {
      const out = await this.launch.createLaunchUrl({
        userId: q.userId ?? '1',
        gameMode: q.gameMode ?? 'chicken-road',
        currency: q.currency ?? process.env.DEFAULT_CURRENCY ?? 'PKR',
        userCountryCode: q.country ?? 'PK',
        lang: 'en',
      });
      return { ok: true, ...out };
    } catch (err: any) {
      // The provider's rejection text is far more useful than a 500 here.
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Mint a launch token without calling the provider — what InOut ask for when
   * they want to drive an init/bet/withdraw cycle themselves.
   *
   *   /debug/token?gameMode=plinko&currency=PKR
   *
   * Single use, and it expires in 5 minutes, so mint it when they are ready.
   */
  @Get('token')
  async mintToken(@Query() q: { userId?: string; gameMode?: string; currency?: string }) {
    const currency = q.currency ?? process.env.DEFAULT_CURRENCY ?? 'PKR';
    const out = await this.launch.mintAuthToken({
      userId: q.userId ?? '1',
      gameMode: q.gameMode ?? 'plinko',
      currency,
    });
    return { ...out, currency, expiresInMinutes: 5 };
  }

  /** Confirms which subId and derived subOperatorId the app is actually using. */
  @Get('identity')
  identity() {
    const aggregatorId = this.config.getOrThrow<string>('INOUT_AGGREGATOR_ID');
    const subId = this.config.getOrThrow<string>('INOUT_SUB_ID');
    const key = this.config.getOrThrow<string>('INOUT_SIGNATURE_KEY');
    return {
      aggregatorId,
      subId,
      subOperatorId: this.config.get<string>('INOUT_SUB_OPERATOR_ID') ?? subOperatorId(aggregatorId, subId),
      subIdToken: subIdToken(aggregatorId, subId, key),
      note: 'subOperatorId is the :operatorId path segment on every bonus API call',
    };
  }

  /** What IP does the app think you are, and is it allowed? */
  @Get('whoami')
  whoami(@Req() req: any) {
    const env = this.config.get<string>('INOUT_ENV', 'prod');
    const extra = (this.config.get<string>('INOUT_EXTRA_IPS') ?? '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    const allowed = [...(INOUT_IP_ALLOWLIST[env] ?? []), ...extra];
    const seen = (req.ip ?? '').replace(/^::ffff:/, '');

    return {
      detectedIp: seen,
      isAllowed: allowed.includes(seen),
      allowed,
      env,
      socketIp: req.socket?.remoteAddress,
      xForwardedFor: req.headers['x-forwarded-for'] ?? null,
      trustProxyHops: process.env.TRUST_PROXY_HOPS ?? '(unset)',
    };
  }

  /**
   * Post the same body and X-REQUEST-SIGN you would send to the webhook.
   * This bypasses both guards and reports what each would have concluded.
   */
  @Post('signature')
  signature(@Req() req: any, @Body() _body: unknown) {
    const key = this.config.get<string>('INOUT_SIGNATURE_KEY') ?? '';
    const raw: Buffer | undefined = req.rawBody;
    const provided = req.header('X-REQUEST-SIGN') ?? null;
    const expected = raw ? createHmac('sha256', key).update(raw).digest('hex') : null;

    return {
      rawBodyReceived: Boolean(raw?.length),
      rawBodyLength: raw?.length ?? 0,
      keyLength: key.length,
      provided,
      expected,
      matches: provided != null && provided.trim().toLowerCase() === expected,
    };
  }
}