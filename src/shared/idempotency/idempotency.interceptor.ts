import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { IdempotencyService } from './idempotency.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const res = http.getResponse<{ statusCode?: number }>();
    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    if (!key) return next.handle();

    return from(this.idempotency.acquire(key)).pipe(
      switchMap((acquire) => {
        if (!acquire.acquired) {
          const existing = acquire.existing;
          if (existing.status === 'in_progress') {
            return throwError(
              () => new ConflictException('request still in flight, retry later'),
            );
          }
          try {
            const statusCode = existing.statusCode ?? 200;
            res.statusCode = statusCode;

            const replayBody = JSON.parse(existing.responseBody ?? 'null');
            if (statusCode >= HttpStatus.BAD_REQUEST) {
              return throwError(() => new HttpException(replayBody, statusCode));
            }
            return of(replayBody);
          } catch (parseErr) {
            this.logger.error(
              { parseErr, key },
              'corrupt idempotency cache — failed to parse cached response',
            );
            return throwError(
              () => new InternalServerErrorException('idempotency cache corrupt'),
            );
          }
        }
        return next.handle().pipe(
          tap((response) => {
            const statusCode = res.statusCode ?? HttpStatus.CREATED;
            this.idempotency.complete(key, statusCode, response).catch((err) =>
              this.logger.error({ err, key }, 'failed to mark idempotency as completed'),
            );
          }),
          catchError((err: unknown) => {
            const statusCode =
              err instanceof HttpException
                ? err.getStatus()
                : HttpStatus.INTERNAL_SERVER_ERROR;

            const responseBody =
              err instanceof HttpException
                ? err.getResponse()
                : {
                    statusCode,
                    error: 'Internal Server Error',
                    message: err instanceof Error ? err.message : 'internal server error',
                  };

            if (statusCode < HttpStatus.INTERNAL_SERVER_ERROR) {
              return from(this.idempotency.complete(key, statusCode, responseBody)).pipe(
                catchError((completeErr) => {
                  this.logger.error(
                    { err: completeErr, key },
                    'failed to cache idempotent error response',
                  );
                  return of(undefined);
                }),
                switchMap(() => throwError(() => err)),
              );
            }

            return from(this.idempotency.release(key)).pipe(
              catchError((releaseErr) => {
                this.logger.error(
                  { err: releaseErr, key },
                  'failed to release idempotency key after transient error',
                );
                return of(undefined);
              }),
              switchMap(() => throwError(() => err)),
            );
          }),
        );
      }),
    );
  }
}
