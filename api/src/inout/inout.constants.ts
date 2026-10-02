/**
 * InOut Games aggregator — constants (spec 2.4 + IP Allowlist).
 */

export enum InoutCode {
  OK = 'OK',
  /** Retryable. Provider will resend withdraw/rollback, and will auto-rollback a bet. */
  TEMPORARY_ERROR = 'TEMPORARY_ERROR',
  INVALID_TOKEN = 'INVALID_TOKEN',
  ACCOUNT_LOCKED = 'ACCOUNT_LOCKED',
  ACCOUNT_INVALID = 'ACCOUNT_INVALID',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  GAME_DISABLED = 'GAME_DISABLED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  CHECKS_FAIL = 'CHECKS_FAIL',
  DEBIT_TRANSACTION_NOT_FOUND = 'DEBIT_TRANSACTION_NOT_FOUND',
}

export enum InoutAction {
  INIT = 'init',
  BET = 'bet',
  WITHDRAW = 'withdraw',
  ROLLBACK = 'rollback',
}

/** Default player-facing messages from spec 2.4. */
export const INOUT_DEFAULT_MESSAGE: Record<string, string> = {
  [InoutCode.TEMPORARY_ERROR]: 'There is a temporary problem with the game server.',
  [InoutCode.INVALID_TOKEN]:
    'There has been a problem with the casino. User authentication failed or your session may be expired, please close the browser and try again.',
  [InoutCode.ACCOUNT_LOCKED]:
    'There has been a problem with the casino. User authentication failed or your session may be expired, please close the browser and try again.',
  [InoutCode.ACCOUNT_INVALID]: 'There has been a problem with the casino. User does not exist.',
  [InoutCode.UNKNOWN_ERROR]: 'Please contact Customer Support for assistance.',
  [InoutCode.GAME_DISABLED]: 'Game is disabled on the casino side.',
  [InoutCode.INSUFFICIENT_FUNDS]: 'You do not have sufficient funds to place this bet.',
  [InoutCode.CHECKS_FAIL]: 'Operation not allowed because of failed checks on the casino side.',
};

/** Provider source IPs that may call our webhook. */
export const INOUT_IP_ALLOWLIST: Record<string, string[]> = {
  prod: [
    '52.67.111.49', // Latin America (Brazil)
    '13.228.247.219', // Southeast Asia (Singapore)
    '3.66.252.239', // Europe
    '15.240.56.64', // Africa (South Africa)
  ],
  stage: ['3.71.240.7'],
  dev: ['3.78.37.192'],
};

/** Default API host. Override with INOUT_API_BASE for dev/stage environments. */
export const INOUT_API_BASE_DEFAULT = 'https://api.inout.games';
export const INOUT_GAME_LIST_PATH = '/api/gameModesList';

/** Webhook must answer inside 10s (spec 2.1) — we self-abort well before that. */
export const INOUT_HANDLER_BUDGET_MS = 7_000;

/** How long a launch (Auth) token stays usable before `init` must happen. */
export const INOUT_AUTH_TOKEN_TTL_MS = 5 * 60_000;

/** How long a game session stays usable for bet/withdraw/rollback. */
export const INOUT_SESSION_TTL_MS = 12 * 60 * 60_000;

/** Bonus webhooks arrive on the same endpoint as the wallet actions. */
export enum InoutBonusAction {
  COMPLETE = 'bonus-complete',
  EXPIRED_WHEN_ACTIVE = 'bonus-expired-when-active',
}

export const INOUT_LAUNCH_PATH = '/api/aggregator/launch';
export const INOUT_OPERATOR_API_PATH = '/api/operator/v1';

/** Spec 3 (frontend): currencies quoted in 9dp. Everything else is fiat, 2dp. */
export const INOUT_CRYPTO_CURRENCIES = [
  'ADA', 'BCH', 'BNB', 'BTC', 'BUSD', 'CSC', 'DASH', 'DOGE', 'ETC', 'ETH', 'LTC',
  'SHIB', 'TON', 'TRX', 'USDC', 'USDT', 'XLM', 'XMR', 'XRP', 'ZEC',
];

/** Interface languages the provider supports; anything else falls back to English. */
export const INOUT_LANGUAGES = new Set([
  'ar','az','bd','bg','bn','br','bs','ca','ch','co','cs','da','de','ec','el','en','es','fa','fr',
  'gu','hi','hr','hu','id','it','ja','jv','kk','ko','kz','la','mr','ms','mx','nl','pa','pe','pl',
  'pt','ro','rs','ru','sp','sv','ta','te','tg','th','tl','tr','ua','uk','ur','uz','vi','vn','zh',
]);