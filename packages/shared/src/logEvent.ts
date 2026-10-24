/**
 * The structured log event contract shared by the Convex backend and the Node
 * services (MTA, IMAP, mail-sync).
 *
 * A log event is a dotted name (`delivery.dispatch.accepted`) plus a FIXED set
 * of top-level keys. The keys are fixed so that an operator's query reads the
 * same on every service: `orgId` is never `organizationId` on one side and
 * `org` on the other, and a send can be followed from the Convex intake to the
 * MTA's SMTP attempt to the webhook that reports it by filtering one key.
 * Anything specific to one event goes under `detail`, so the shared vocabulary
 * cannot drift by accretion.
 *
 * Values are primitives only. A nested object in a process log is where mail
 * content hides, and the PII gate (`apps/api/scripts/check-log-pii.sh`) reads
 * keys, which a nested blob would put out of its sight.
 */

/** Severity of a log event. Maps one-to-one onto console / pino methods. */
export type LogEventSeverity = 'debug' | 'info' | 'warn' | 'error';

type LogEventPrimitive = string | number | boolean | null;

/**
 * The fixed top-level keys. Every key is optional; an event carries the ones
 * it knows.
 */
export interface LogEventFields {
	/** Organization the work belongs to. */
	orgId?: string;
	/** Durable Send row id (`transactionalSends` / `emailSends`). */
	sendId?: string;
	/** Bounded queue attempt identity for one governed dispatch. */
	workAttemptId?: string;
	/** Stable provider/VERP message identity the MTA reports outcomes on. */
	messageId?: string;
	/** The `x-owlat-correlation` id that ties one request across services. */
	correlationId?: string;
	/** Wall-clock milliseconds the logged operation took. */
	durationMs?: number;
	/** What happened, as a short token (`accepted`, `failed`, `deferred`, …). */
	outcome?: string;
	/**
	 * Failure category: an Operation-error category in Convex (`forbidden`,
	 * `internal`, …), the SMTP classification in the MTA.
	 */
	category?: string;
	/** Event-specific facts. Primitives only; never addresses or subjects in the clear. */
	detail?: Record<string, LogEventPrimitive | undefined>;
}

const FIELD_KEYS = [
	'orgId',
	'sendId',
	'workAttemptId',
	'messageId',
	'correlationId',
	'durationMs',
	'outcome',
	'category',
] as const satisfies readonly Exclude<keyof LogEventFields, 'detail'>[];

/** The fixed keys plus `detail`, with every undefined value dropped. */
type LogEventPayload = Omit<LogEventFields, 'detail'> & {
	detail?: Record<string, LogEventPrimitive>;
};

const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/**
 * Keep only the fixed keys (and a primitive-only `detail`), dropping undefined
 * values, so a log line never carries `"sendId": undefined` noise and a caller
 * that spreads a wider object cannot smuggle extra top-level keys past the
 * contract. Used for pino child-logger bindings and as the body of every event.
 */
export function logEventBindings(fields: LogEventFields): LogEventPayload {
	const payload: LogEventPayload = {};
	const target = payload as Record<string, unknown>;
	for (const key of FIELD_KEYS) {
		const value = fields[key];
		if (value !== undefined) target[key] = value;
	}
	if (fields.detail) {
		const detail: Record<string, LogEventPrimitive> = {};
		for (const [key, value] of Object.entries(fields.detail)) {
			if (value !== undefined) detail[key] = value;
		}
		if (Object.keys(detail).length > 0) payload.detail = detail;
	}
	return payload;
}

/**
 * The full record one event serializes to: `event` first so a line reads
 * name-first, then `level`, then the payload.
 *
 * Never throws: a log call often sits in a `catch`, where a throw would replace
 * the error being reported. A name that is not a lowercase dotted path
 * (`domain.event`) is therefore not refused but re-filed under
 * `log.malformed_event` with the offending name in `detail`, so the line still
 * lands and the typo is one query away.
 */
export function logEventRecord(
	event: string,
	severity: LogEventSeverity,
	fields: LogEventFields
): { event: string; level: LogEventSeverity } & LogEventPayload {
	if (EVENT_NAME.test(event)) {
		return { event, level: severity, ...logEventBindings(fields) };
	}
	return {
		event: 'log.malformed_event',
		level: severity,
		...logEventBindings({
			...fields,
			detail: { ...fields.detail, eventName: event.slice(0, 128) },
		}),
	};
}
