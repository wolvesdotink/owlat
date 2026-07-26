export const DESTINATION_PROVIDER_KEYS = ['gmail', 'microsoft', 'yahoo', 'apple', 'other'] as const;

export type DestinationProviderKey = (typeof DESTINATION_PROVIDER_KEYS)[number];
export type DeliverabilitySignalProvider = DestinationProviderKey | 'all';
export const DELIVERABILITY_SIGNAL_SOURCES = [
	'ip_quarantined',
	'dnsbl_listed',
	'dnsbl_partial',
	'dnsbl_unknown',
	'breaker_open',
	'persistent_defers',
] as const;
export type DeliverabilitySignalSource = (typeof DELIVERABILITY_SIGNAL_SOURCES)[number];

/**
 * Advisory sources describe what the MTA could MEASURE, not a routing verdict.
 *
 * `dnsbl_unknown` means a blocklist lookup could not be completed (timeout,
 * SERVFAIL, REFUSED, resolver policy, rate limit) — that is explicitly NOT
 * evidence of health, and it is equally not evidence of harm, so it must never
 * be laundered into "clean" and must never by itself flip a cell to the relay.
 * `dnsbl_partial` means at least one — but not every — configured pool address
 * is blocklist-ejected; the pool still has healthy addresses to send from, so
 * shipped routing keeps sending, while the reading stays visible to the ramp
 * controller's blocklist hard stop.
 *
 * Advisory signals are recorded and readable; only actionable sources drive the
 * shipped fallback + hysteresis transition.
 */
export const ADVISORY_DELIVERABILITY_SIGNAL_SOURCES = ['dnsbl_partial', 'dnsbl_unknown'] as const;
export type AdvisoryDeliverabilitySignalSource =
	(typeof ADVISORY_DELIVERABILITY_SIGNAL_SOURCES)[number];
export type ActionableDeliverabilitySignalSource = Exclude<
	DeliverabilitySignalSource,
	AdvisoryDeliverabilitySignalSource
>;
export type DeliverabilitySignalSeverity = 'warning' | 'critical';

export function isDeliverabilitySignalSource(value: unknown): value is DeliverabilitySignalSource {
	return (
		typeof value === 'string' &&
		(DELIVERABILITY_SIGNAL_SOURCES as readonly string[]).includes(value)
	);
}

export function isAdvisoryDeliverabilitySignalSource(
	value: DeliverabilitySignalSource
): value is AdvisoryDeliverabilitySignalSource {
	return (ADVISORY_DELIVERABILITY_SIGNAL_SOURCES as readonly string[]).includes(value);
}

export function isActionableDeliverabilitySignalSource(
	value: DeliverabilitySignalSource
): value is ActionableDeliverabilitySignalSource {
	return !isAdvisoryDeliverabilitySignalSource(value);
}

/** True when at least one pool address is blocklist-ejected, wholly or partly. */
export function hasCriticalBlocklistSignal(signals: readonly DeliverabilitySignal[]): boolean {
	return signals.some(
		(signal) =>
			signal.severity === 'critical' &&
			(signal.source === 'dnsbl_listed' || signal.source === 'dnsbl_partial')
	);
}

export interface DeliverabilitySignal {
	provider: DeliverabilitySignalProvider;
	source: DeliverabilitySignalSource;
	severity: DeliverabilitySignalSeverity;
	observedAt: number;
}

export interface DeliverabilityRoutingSnapshot {
	generatedAt: number;
	signals: DeliverabilitySignal[];
}

const MAX_SIGNALS = 32;
export const DELIVERABILITY_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
export const DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

export function isDestinationProviderKey(value: unknown): value is DestinationProviderKey {
	return (
		typeof value === 'string' && (DESTINATION_PROVIDER_KEYS as readonly string[]).includes(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSignal(value: unknown, generatedAt: number, now: number): value is DeliverabilitySignal {
	if (!isRecord(value)) return false;
	if (!hasExactKeys(value, ['provider', 'source', 'severity', 'observedAt'])) return false;
	const provider = value['provider'];
	const source = value['source'];
	const severity = value['severity'];
	const observedAt = value['observedAt'];
	return (
		(provider === 'all' || isDestinationProviderKey(provider)) &&
		isDeliverabilitySignalSource(source) &&
		(severity === 'warning' || severity === 'critical') &&
		typeof observedAt === 'number' &&
		Number.isFinite(observedAt) &&
		observedAt >= 0 &&
		observedAt <= generatedAt &&
		generatedAt - observedAt <= DELIVERABILITY_SNAPSHOT_MAX_AGE_MS &&
		observedAt <= now + DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS &&
		now - observedAt <= DELIVERABILITY_SNAPSHOT_MAX_AGE_MS
	);
}

/** Strict parser for the authenticated MTA routing-signal snapshot. */
export function normalizeDeliverabilityRoutingSnapshot(
	value: unknown,
	now = Date.now()
): DeliverabilityRoutingSnapshot | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['generatedAt', 'signals']) ||
		typeof value['generatedAt'] !== 'number' ||
		!Number.isFinite(value['generatedAt']) ||
		value['generatedAt'] < 0 ||
		value['generatedAt'] > now + DELIVERABILITY_SNAPSHOT_MAX_FUTURE_SKEW_MS ||
		now - value['generatedAt'] > DELIVERABILITY_SNAPSHOT_MAX_AGE_MS ||
		!Array.isArray(value['signals']) ||
		value['signals'].length > MAX_SIGNALS ||
		!value['signals'].every((signal) => isSignal(signal, value['generatedAt'] as number, now))
	) {
		return null;
	}
	return {
		generatedAt: value['generatedAt'],
		signals: value['signals'].map((signal) => ({
			provider: signal.provider,
			source: signal.source,
			severity: signal.severity,
			observedAt: signal.observedAt,
		})),
	};
}

/**
 * Conservative address-domain classifier used before an MX-derived observation
 * exists. Custom-domain Google/Microsoft tenants deliberately remain `other`.
 */
export function destinationProviderForDomain(domain: string): DestinationProviderKey {
	const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
	if (normalized === 'gmail.com' || normalized === 'googlemail.com') return 'gmail';
	if (
		normalized === 'outlook.com' ||
		normalized === 'hotmail.com' ||
		normalized === 'live.com' ||
		normalized === 'msn.com'
	)
		return 'microsoft';
	if (
		normalized === 'yahoo.com' ||
		normalized === 'aol.com' ||
		normalized === 'ymail.com' ||
		normalized === 'yahoo.co.uk'
	)
		return 'yahoo';
	if (normalized === 'icloud.com' || normalized === 'me.com' || normalized === 'mac.com')
		return 'apple';
	return 'other';
}
