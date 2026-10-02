import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InoutSessionService } from './inout-session.service';
import { subIdToken } from './util/inout-ids.util';
import {
  INOUT_API_BASE_DEFAULT,
  INOUT_GAME_LIST_PATH,
  INOUT_LANGUAGES,
  INOUT_LAUNCH_PATH,
} from './inout.constants';

export interface InoutGame {
  gameMode: string;
  title: string;
  description: string;
  /** 'instant' | 'slots' | 'crash_game' | 'roulette' — use for lobby sections. */
  category: string;
  /** Keyed by size, e.g. url_200_200. Only `url` is always present. */
  iconsUrls: Record<string, string>;
  multiplayer: boolean;
  rtp: string;
  /**
   * Which bonus types this game accepts. A FREEBET grant for a game whose
   * bonusTypes does not include 'FREEBET' will be rejected by the provider,
   * so check this before creating one.
   */
  bonusTypes: string[];
}

@Injectable()
export class InoutLaunchService {
  private readonly log = new Logger(InoutLaunchService.name);
  private cache?: { at: number; games: InoutGame[] };

  private readonly aggregatorId: string;
  private readonly subId: string;
  private readonly secretKey: string;
  private readonly brandName: string;
  private readonly lobbyUrl: string;
  private readonly apiBase: string;

  constructor(
    private readonly sessions: InoutSessionService,
    private readonly config: ConfigService,
  ) {
    this.aggregatorId = config.getOrThrow<string>('INOUT_AGGREGATOR_ID');
    this.subId = config.getOrThrow<string>('INOUT_SUB_ID');
    this.secretKey = config.getOrThrow<string>('INOUT_SIGNATURE_KEY');
    this.brandName = config.get<string>('INOUT_BRAND_NAME', 'BS Exchange');
    this.lobbyUrl = config.get<string>('INOUT_LOBBY_URL', 'https://bsexchange.live/casino');
    this.apiBase = (config.get<string>('INOUT_API_BASE') ?? INOUT_API_BASE_DEFAULT).replace(/\/$/, '');
  }

  /** Games that accept FREEBET grants. Filter the bonus admin UI with this. */
  async freebetGames(): Promise<InoutGame[]> {
    const games = await this.listGames();
    return games.filter((g) => g.bonusTypes?.includes('FREEBET'));
  }

  /** Backend spec 1 — GET /api/gameModesList?operatorId=... Cached for 10 minutes. */
  async listGames(force = false): Promise<InoutGame[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 600_000) {
      return this.cache.games;
    }
    const url = `${this.apiBase}${INOUT_GAME_LIST_PATH}?operatorId=${encodeURIComponent(this.aggregatorId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      this.log.error(`gameModesList failed: ${res.status}`);
      if (this.cache) return this.cache.games; // serve stale rather than an empty lobby
      throw new Error(`gameModesList returned ${res.status}`);
    }
    const games = (await res.json()) as InoutGame[];
    this.cache = { at: Date.now(), games };
    return games;
  }

  /** A launch token on its own, for the provider's own test runs. */
  async mintAuthToken(p: { userId: string; gameMode: string; currency: string }) {
    const games = await this.listGames();
    if (!games.some((g) => g.gameMode === p.gameMode)) {
      throw new Error(`unknown gameMode ${p.gameMode}`);
    }
    return this.sessions.createLaunchToken(p);
  }

  /**
   * Frontend spec 7.2 — the launch call is server-to-server.
   *
   * The browser must never hit api.inout.games directly: if that domain is
   * blocked in the player's country the game simply fails to load. We call it
   * from our backend, the provider picks a domain that works for that country,
   * and only the resulting launchUrl goes to the client.
   */
  async createLaunchUrl(p: {
    userId: string;
    gameMode: string;
    currency: string;
    userCountryCode: string;
    lang?: string;
    isDemoPlay?: boolean;
  }): Promise<{ launchUrl: string; sessionId: string }> {
    const games = await this.listGames();
    if (!games.some((g) => g.gameMode === p.gameMode)) {
      throw new Error(`unknown gameMode ${p.gameMode}`);
    }

    const country = normaliseCountry(p.userCountryCode);
    const lang = p.lang && INOUT_LANGUAGES.has(p.lang) ? p.lang : 'en';
    const { authToken, sessionId } = await this.sessions.createLaunchToken({
      userId: p.userId,
      gameMode: p.gameMode,
      currency: p.currency,
    });

    const qs = new URLSearchParams({
      aggregatorId: this.aggregatorId,
      subId: this.subId,
      gameMode: p.gameMode,
      currency: p.isDemoPlay ? 'USD' : p.currency,
      authToken,
      lang,
      strategy: 'redirect',
      adaptive: 'true',
      isDemoPlay: String(Boolean(p.isDemoPlay)),
      token: subIdToken(this.aggregatorId, this.subId, this.secretKey),
      userCountryCode: country,
      lobbyUrl: this.lobbyUrl,
      brandName: this.brandName,
    });

    // redirect: 'manual' is the important part. With strategy=redirect the
    // provider answers 302 and puts the region-specific game URL in Location;
    // following it would just fetch the game's HTML server-side, which is both
    // useless and the thing we are trying to avoid doing from the browser.
    const res = await fetch(`${this.apiBase}${INOUT_LAUNCH_PATH}?${qs}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) return { launchUrl: location, sessionId };
      throw new Error(`launch redirected with no Location header (${res.status})`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`launch returned ${res.status}: ${readableError(text)}`);
    }

    // Some deployments answer with the documented JSON instead of a redirect.
    try {
      const body = JSON.parse(text) as { launchUrl?: string };
      if (body.launchUrl) return { launchUrl: body.launchUrl, sessionId };
    } catch {
      // Not JSON — fall through so the error carries what actually came back.
    }

    throw new Error(`launch failed: ${readableError(text)}`);
  }
}

/**
 * The provider reports launch failures as a styled HTML page, so the actual
 * message is buried in markup. Pull out the readable text.
 */
function readableError(html: string): string {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, 600) || html.slice(0, 600);
}

/**
 * Frontend spec 7.3 — must be a real two-letter ISO 3166-1 alpha-2 code, uppercase.
 * Dummy values are explicitly rejected by the provider, so we fail loudly here
 * rather than shipping XX and having launches break in one region only.
 */
export function normaliseCountry(raw: string | undefined): string {
  const c = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX') {
    throw new Error(`userCountryCode "${raw}" is not a valid ISO 3166-1 alpha-2 code`);
  }
  return c;
}