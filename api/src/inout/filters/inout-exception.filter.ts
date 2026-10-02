import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { INOUT_DEFAULT_MESSAGE, InoutCode } from '../inout.constants';

/** Throw this anywhere in the webhook path to answer with a specific code. */
export class InoutRejection extends Error {
  constructor(
    readonly code: InoutCode,
    readonly reason?: string,
    readonly playerMessage?: string,
  ) {
    super(reason ?? code);
  }
}

/**
 * Spec 2.1: "The expected HTTP code for a successful response is 200. Any other
 * code will be interpreted as an error even if the code field in the response is OK."
 *
 * So the HTTP layer must never leak a 4xx/5xx — every outcome, success or
 * failure, goes back as 200 with the outcome in the body. An uncaught crash
 * becomes TEMPORARY_ERROR, which is the retryable code: for `bet` the provider
 * auto-rolls back (2.51), for withdraw/rollback it resends with backoff (2.52).
 * That is exactly the behaviour we want when we don't know what happened.
 */
@Catch()
export class InoutExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('InoutWebhook');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();

    if (err instanceof InoutRejection) {
      // console.error, not Logger.warn: under Passenger only stderr is captured
      // to stderr.log, and a rejection nobody can see is a rejection nobody can
      // debug. Remove once proper logging is in place.
      console.error(
        `[inout] REJECTED ${err.code} :: ${err.reason ?? 'no reason'} :: ` +
          `ip=${req?.ip} xff=${req?.headers?.['x-forwarded-for'] ?? '-'} ` +
          `action=${req?.body?.action ?? '-'}`,
      );
      return res.status(200).json({
        code: err.code,
        message: err.playerMessage ?? INOUT_DEFAULT_MESSAGE[err.code],
      });
    }

    console.error(
      `[inout] UNHANDLED action=${req?.body?.action ?? '-'} :: ${(err as Error)?.message}`,
      (err as Error)?.stack,
    );
    return res.status(200).json({
      code: InoutCode.TEMPORARY_ERROR,
      message: INOUT_DEFAULT_MESSAGE[InoutCode.TEMPORARY_ERROR],
    });
  }
}