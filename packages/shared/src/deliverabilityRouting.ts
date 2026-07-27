export const DESTINATION_PROVIDER_KEYS = ['gmail', 'microsoft', 'yahoo', 'apple', 'other'] as const;

export type DestinationProviderKey = (typeof DESTINATION_PROVIDER_KEYS)[number];
export type DeliverabilitySignalProvider = DestinationProviderKey | 'all';

/**
 * Sending streams. A ramp cell is `(stream, destinationProvider)`; the stream
 * axis is what lets transactional mail ramp on different constants from bulk
 * campaign mail. Defined once here so the schema validator, the cell key and
 * the controller cannot drift.
 */
export const DELIVERABILITY_STREAM_KEYS = ['campaign', 'automation', 'transactional'] as const;
export type DeliverabilityStream = (typeof DELIVERABILITY_STREAM_KEYS)[number];

export function isDeliverabilityStream(value: unknown): value is DeliverabilityStream {
	return (
		typeof value === 'string' && (DELIVERABILITY_STREAM_KEYS as readonly string[]).includes(value)
	);
}

/** Canonical cell key: `${stream}:${destinationProvider}`. */
export function deliverabilityCellKey(
	stream: DeliverabilityStream,
	destinationProvider: DestinationProviderKey
): string {
	return `${stream}:${destinationProvider}`;
}

export function parseDeliverabilityCellKey(
	value: string
): { stream: DeliverabilityStream; destinationProvider: DestinationProviderKey } | null {
	const separator = value.indexOf(':');
	if (separator < 0) return null;
	const stream = value.slice(0, separator);
	const destinationProvider = value.slice(separator + 1);
	if (!isDeliverabilityStream(stream) || !isDestinationProviderKey(destinationProvider)) return null;
	return { stream, destinationProvider };
}

/**
 * Infrastructure sources are the SHIPPED fallback triggers: they, and only
 * they, flip a provider slice onto the relay through the shipped hysteresis.
 */
export const INFRASTRUCTURE_DELIVERABILITY_SIGNAL_SOURCES = [
	'ip_quarantined',
	'dnsbl_listed',
	'breaker_open',
	'persistent_defers',
] as const;

/**
 * Outcome-derived sources describe what happened to mail that was ACCEPTED —
 * the class of failure infrastructure health cannot see (mail accepted and
 * silently filed to Spam). They are recorded and readable, they move the ramp
 * controller's share, and they never on their own flip the shipped boolean.
 */
export const OUTCOME_DELIVERABILITY_SIGNAL_SOURCES = [
	'bounce_rate',
	'complaint_rate',
	'engagement_ratio',
	'seed_placement',
] as const;

export type InfrastructureDeliverabilitySignalSource =
	(typeof INFRASTRUCTURE_DELIVERABILITY_SIGNAL_SOURCES)[number];
export type OutcomeDeliverabilitySignalSource =
	(typeof OUTCOME_DELIVERABILITY_SIGNAL_SOURCES)[number];

export const DELIVERABILITY_SIGNAL_SOURCES = [
	'ip_quarantined',
	'dnsbl_listed',
	'dnsbl_partial',
	'dnsbl_unknown',
	'breaker_open',
	'persistent_defers',
	...OUTCOME_DELIVERABILITY_SIGNAL_SOURCES,
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
/**
 * "Actionable" means actionable for the SHIPPED relay fallback — the four
 * infrastructure sources. Advisory (measurement-state) and outcome-derived
 * sources are deliberately excluded: widening the union must not widen what
 * can flip a provider slice onto the relay.
 */
export type ActionableDeliverabilitySignalSource = InfrastructureDeliverabilitySignalSource;
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

export function isOutcomeDeliverabilitySignalSource(
	value: DeliverabilitySignalSource
): value is OutcomeDeliverabilitySignalSource {
	return (OUTCOME_DELIVERABILITY_SIGNAL_SOURCES as readonly string[]).includes(value);
}

export function isActionableDeliverabilitySignalSource(
	value: DeliverabilitySignalSource
): value is ActionableDeliverabilitySignalSource {
	return (INFRASTRUCTURE_DELIVERABILITY_SIGNAL_SOURCES as readonly string[]).includes(value);
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

/**
 * The share-resolution contract (D1).
 *
 * `deliverabilityRouteStates` is being widened from a boolean to a share in
 * [0,1]; the boolean is the DEGENERATE CASE. Rows written before the migration
 * carry no `ownShare` and must keep working forever, so EVERY reader resolves
 * `ownShare ?? (isFallbackActive ? 0 : 1)` — through this one helper. A second
 * inline copy that drifts is a defect.
 */
export interface DeliverabilityRouteShareState {
	isFallbackActive: boolean;
	ownShare?: number | undefined;
}

export const OWN_SHARE_FLOOR = 0;
export const OWN_SHARE_CEILING = 1;

/**
 * The write-boundary clamp. It FAILS CLOSED: a non-finite share (`NaN` from a
 * zero-volume cell's 0/0, `±Infinity` from a division that lost its guard) is
 * degenerate evidence, and degenerate evidence must never be able to push the
 * own MTA's share UP. Everything unusable resolves to the floor — full relay.
 */
export function clampOwnShare(value: number): number {
	if (!Number.isFinite(value)) return OWN_SHARE_FLOOR;
	if (value < OWN_SHARE_FLOOR) return OWN_SHARE_FLOOR;
	if (value > OWN_SHARE_CEILING) return OWN_SHARE_CEILING;
	return value;
}

/**
 * Fraction of this cell's traffic that the own MTA carries. A missing row is
 * the un-migrated, un-degraded default: the own MTA carries everything.
 */
export function resolveOwnShare(state: DeliverabilityRouteShareState | null | undefined): number {
	if (!state) return OWN_SHARE_CEILING;
	if (state.ownShare === undefined || !Number.isFinite(state.ownShare)) {
		return state.isFallbackActive ? OWN_SHARE_FLOOR : OWN_SHARE_CEILING;
	}
	return clampOwnShare(state.ownShare);
}

/**
 * `isFallbackActive` as a DERIVED VIEW of the share: the relay is engaged
 * whenever the own MTA does not carry the whole cell. For a legacy row this is
 * exactly the stored boolean, which is what keeps the shipped hysteresis and
 * every shipped consumer byte-for-byte unchanged.
 */
export function isFallbackActiveForShare(ownShare: number): boolean {
	return clampOwnShare(ownShare) < OWN_SHARE_CEILING;
}

/**
 * Is the relay engaged for this row?
 *
 * The stored boolean and the stored share have DIFFERENT WRITERS on different
 * cadences: the MTA snapshot flips `isFallbackActive` from infrastructure
 * health every ~10 minutes, while the ramp controller writes `ownShare` hourly.
 * So this is a UNION, not a lookup — an infrastructure verdict (breaker open,
 * critical DNSBL listing, quarantined IP) stays honoured even while a share is
 * stored, instead of being ignored until the controller's next tick.
 *
 * `resolveOwnShare` keeps the D1 contract untouched (`ownShare ?? (isFallbackActive ? 0 : 1)`),
 * so a legacy row still resolves to exactly its stored boolean.
 */
export function isRouteStateFallbackActive(
	state: DeliverabilityRouteShareState | null | undefined
): boolean {
	if (!state) return false;
	return state.isFallbackActive || isFallbackActiveForShare(resolveOwnShare(state));
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
