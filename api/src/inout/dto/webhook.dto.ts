import { InoutAction } from '../inout.constants';

/** Spec 3.1 */
export interface InitRequest {
  action: InoutAction.INIT;
  token: string; // AuthToken
  data: { currency: string; operator: string; gameMode: string };
}

/** Spec 3.2 */
export interface BetRequest {
  action: InoutAction.BET;
  token: string; // SessionToken
  gameMode: string;
  data: {
    amount: string;
    currency: string;
    user_id: string;
    operator: string;
    transactionId: string;
    gameId: string;
  };
}

/** Spec 3.3 — `result` already includes the stake; never credit `amount` on top. */
export interface WithdrawRequest {
  action: InoutAction.WITHDRAW;
  token: string;
  gameMode: string;
  data: {
    user_id: string;
    currency: string;
    operator: string;
    amount: string;
    result: string;
    coefficient: string;
    transactionId: string;
    debitId: string;
    gameId: string;
    isFinished: boolean;
  };
}

/** Spec 3.4 */
export interface RollbackRequest {
  action: InoutAction.ROLLBACK;
  token: string;
  gameMode: string;
  data: {
    user_id: string;
    currency: string;
    operator: string;
    amount: string;
    transactionId: string;
    debitId: string;
    gameId: string;
    isFinished: boolean;
  };
}

export type InoutRequest =
  | InitRequest
  | BetRequest
  | WithdrawRequest
  | RollbackRequest
  | BonusWebhookRequest;

export interface InoutResponse {
  code: string;
  message?: string;
  balance?: string;
  userId?: string;
  nickname?: string;
  currency?: string;
  operator?: string;
  userAvatar?: string;
  token?: string;
  /** Bonus spec 6: optionally exclude this player from the provider's statistics. */
  hideFromStat?: boolean;
}

/**
 * Bonus spec 6.1 / 6.2.
 *
 * Note the field is `userId` here, not `user_id` as in the wallet actions.
 * The inconsistency is in the provider's spec, not a transcription slip.
 */
export interface BonusWebhookRequest {
  action: 'bonus-complete' | 'bonus-expired-when-active';
  token: string;
  gameMode: string;
  data: {
    bonusId: string;
    currency: string;
    winSum: string;
    operator: string;
    userId: string;
    transactionId: string;
  };
}
