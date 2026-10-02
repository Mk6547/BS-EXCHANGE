"use strict";
/**
 * InOut Games aggregator — constants (spec 2.4 + IP Allowlist).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.INOUT_LANGUAGES = exports.INOUT_CRYPTO_CURRENCIES = exports.INOUT_OPERATOR_API_PATH = exports.INOUT_LAUNCH_PATH = exports.InoutBonusAction = exports.INOUT_SESSION_TTL_MS = exports.INOUT_AUTH_TOKEN_TTL_MS = exports.INOUT_HANDLER_BUDGET_MS = exports.INOUT_GAME_LIST_PATH = exports.INOUT_API_BASE_DEFAULT = exports.INOUT_IP_ALLOWLIST = exports.INOUT_DEFAULT_MESSAGE = exports.InoutAction = exports.InoutCode = void 0;
var InoutCode;
(function (InoutCode) {
    InoutCode["OK"] = "OK";
    /** Retryable. Provider will resend withdraw/rollback, and will auto-rollback a bet. */
    InoutCode["TEMPORARY_ERROR"] = "TEMPORARY_ERROR";
    InoutCode["INVALID_TOKEN"] = "INVALID_TOKEN";
    InoutCode["ACCOUNT_LOCKED"] = "ACCOUNT_LOCKED";
    InoutCode["ACCOUNT_INVALID"] = "ACCOUNT_INVALID";
    InoutCode["UNKNOWN_ERROR"] = "UNKNOWN_ERROR";
    InoutCode["GAME_DISABLED"] = "GAME_DISABLED";
    InoutCode["INSUFFICIENT_FUNDS"] = "INSUFFICIENT_FUNDS";
    InoutCode["CHECKS_FAIL"] = "CHECKS_FAIL";
    InoutCode["DEBIT_TRANSACTION_NOT_FOUND"] = "DEBIT_TRANSACTION_NOT_FOUND";
})(InoutCode || (exports.InoutCode = InoutCode = {}));
var InoutAction;
(function (InoutAction) {
    InoutAction["INIT"] = "init";
    InoutAction["BET"] = "bet";
    InoutAction["WITHDRAW"] = "withdraw";
    InoutAction["ROLLBACK"] = "rollback";
})(InoutAction || (exports.InoutAction = InoutAction = {}));
/** Default player-facing messages from spec 2.4. */
exports.INOUT_DEFAULT_MESSAGE = {
    [InoutCode.TEMPORARY_ERROR]: 'There is a temporary problem with the game server.',
    [InoutCode.INVALID_TOKEN]: 'There has been a problem with the casino. User authentication failed or your session may be expired, please close the browser and try again.',
    [InoutCode.ACCOUNT_LOCKED]: 'There has been a problem with the casino. User authentication failed or your session may be expired, please close the browser and try again.',
    [InoutCode.ACCOUNT_INVALID]: 'There has been a problem with the casino. User does not exist.',
    [InoutCode.UNKNOWN_ERROR]: 'Please contact Customer Support for assistance.',
    [InoutCode.GAME_DISABLED]: 'Game is disabled on the casino side.',
    [InoutCode.INSUFFICIENT_FUNDS]: 'You do not have sufficient funds to place this bet.',
    [InoutCode.CHECKS_FAIL]: 'Operation not allowed because of failed checks on the casino side.',
};
/** Provider source IPs that may call our webhook. */
exports.INOUT_IP_ALLOWLIST = {
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
exports.INOUT_API_BASE_DEFAULT = 'https://api.inout.games';
exports.INOUT_GAME_LIST_PATH = '/api/gameModesList';
/** Webhook must answer inside 10s (spec 2.1) — we self-abort well before that. */
exports.INOUT_HANDLER_BUDGET_MS = 7_000;
/** How long a launch (Auth) token stays usable before `init` must happen. */
exports.INOUT_AUTH_TOKEN_TTL_MS = 5 * 60_000;
/** How long a game session stays usable for bet/withdraw/rollback. */
exports.INOUT_SESSION_TTL_MS = 12 * 60 * 60_000;
/** Bonus webhooks arrive on the same endpoint as the wallet actions. */
var InoutBonusAction;
(function (InoutBonusAction) {
    InoutBonusAction["COMPLETE"] = "bonus-complete";
    InoutBonusAction["EXPIRED_WHEN_ACTIVE"] = "bonus-expired-when-active";
})(InoutBonusAction || (exports.InoutBonusAction = InoutBonusAction = {}));
exports.INOUT_LAUNCH_PATH = '/api/aggregator/launch';
exports.INOUT_OPERATOR_API_PATH = '/api/operator/v1';
/** Spec 3 (frontend): currencies quoted in 9dp. Everything else is fiat, 2dp. */
exports.INOUT_CRYPTO_CURRENCIES = [
    'ADA', 'BCH', 'BNB', 'BTC', 'BUSD', 'CSC', 'DASH', 'DOGE', 'ETC', 'ETH', 'LTC',
    'SHIB', 'TON', 'TRX', 'USDC', 'USDT', 'XLM', 'XMR', 'XRP', 'ZEC',
];
/** Interface languages the provider supports; anything else falls back to English. */
exports.INOUT_LANGUAGES = new Set([
    'ar', 'az', 'bd', 'bg', 'bn', 'br', 'bs', 'ca', 'ch', 'co', 'cs', 'da', 'de', 'ec', 'el', 'en', 'es', 'fa', 'fr',
    'gu', 'hi', 'hr', 'hu', 'id', 'it', 'ja', 'jv', 'kk', 'ko', 'kz', 'la', 'mr', 'ms', 'mx', 'nl', 'pa', 'pe', 'pl',
    'pt', 'ro', 'rs', 'ru', 'sp', 'sv', 'ta', 'te', 'tg', 'th', 'tl', 'tr', 'ua', 'uk', 'ur', 'uz', 'vi', 'vn', 'zh',
]);
