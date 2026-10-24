import { logEventRecord, type LogEventFields, type LogEventSeverity } from '@owlat/shared/logEvent';

export function logError(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.error(message, ...optionalParams);
}

export function logWarn(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.warn(message, ...optionalParams);
}

export function logInfo(message?: unknown, ...optionalParams: unknown[]): void {
	globalThis.console?.log(message, ...optionalParams);
}

const CONSOLE_METHOD = {
	debug: 'debug',
	info: 'info',
	warn: 'warn',
	error: 'error',
} as const satisfies Record<LogEventSeverity, keyof Console>;

/**
 * Emit one named, structured log event: `logEvent('delivery.dispatch.accepted',
 * { orgId, sendId, correlationId, outcome: 'accepted' })`.
 *
 * The line is a single JSON object (`{"event":…,"level":…,"orgId":…}`) so a log
 * aggregator parses it without a pattern, and its keys are the fixed list in
 * `@owlat/shared/logEvent` that the MTA's pino lines use too. Prefer this over
 * `logInfo('[Tag] text', …)` for anything an operator will query: the event
 * name is the greppable handle, and `detail` holds the event-specific facts.
 */
export function logEvent(
	event: string,
	fields: LogEventFields = {},
	severity: LogEventSeverity = 'info'
): void {
	const line = JSON.stringify(logEventRecord(event, severity, fields));
	globalThis.console?.[CONSOLE_METHOD[severity]](line);
}
