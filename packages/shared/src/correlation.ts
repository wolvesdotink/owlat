/**
 * The cross-service correlation id: one opaque token that follows a request
 * from the Convex backend into the MTA and back out on the MTA's webhooks, so
 * the log lines of all three hops can be joined on one key (`correlationId`,
 * see `./logEvent`).
 *
 * It is carried in the `x-owlat-correlation` HTTP header on every Convex → MTA
 * call and echoed as the `correlationId` field of the webhook events the MTA
 * reports for that message.
 *
 * It is a LOG key and nothing else: it never feeds an idempotency key, a work
 * identity, a routing digest, a signature or a MIME header. A missing or
 * malformed id therefore costs a join in a log query, never a send.
 */

/** HTTP header name. Lowercase because Hono and `Headers` normalize to it. */
export const CORRELATION_HEADER = 'x-owlat-correlation';

/**
 * Bounded, printable, header-safe. Starts with an alphanumeric so a value can
 * never be mistaken for a flag or an empty-ish token, and excludes whitespace,
 * quotes and separators so it is safe in a header, a log line and a Redis job.
 */
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Is `value` a well-formed correlation id? */
export function isCorrelationId(value: unknown): value is string {
	return typeof value === 'string' && CORRELATION_ID.test(value);
}

/**
 * Read a correlation id off an inbound header value. A malformed value is
 * dropped, not repaired: the id is log-only, so the safe answer to garbage is
 * "no correlation", never a 400.
 */
export function readCorrelationId(value: string | null | undefined): string | undefined {
	return isCorrelationId(value) ? value : undefined;
}

/**
 * Mint a fresh id for a call that has none to carry (an operator action, a
 * Postbox send). `prefix` names the producer so a bare id still says where it
 * started; it must itself be a short lowercase token.
 */
export function mintCorrelationId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * The header record to spread into a Convex → MTA request: the caller's id
 * when it has one, else a freshly minted one under `prefix`.
 */
export function correlationHeader(
	correlationId: string | undefined,
	prefix: string
): { [CORRELATION_HEADER]: string } {
	return { [CORRELATION_HEADER]: correlationId ?? mintCorrelationId(prefix) };
}
