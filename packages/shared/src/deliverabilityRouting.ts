export const DESTINATION_PROVIDER_KEYS = ['gmail', 'microsoft', 'yahoo', 'apple', 'other'] as const;

export type DestinationProviderKey = (typeof DESTINATION_PROVIDER_KEYS)[number];
export type DeliverabilitySignalProvider = DestinationProviderKey | 'all';
export type DeliverabilitySignalSource =
	| 'ip_quarantined'
	| 'dnsbl_listed'
	| 'breaker_open'
	| 'persistent_defers';
export type DeliverabilitySignalSeverity = 'warning' | 'critical';

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

export function isDestinationProviderKey(value: unknown): value is DestinationProviderKey {
	return (
		typeof value === 'string' && (DESTINATION_PROVIDER_KEYS as readonly string[]).includes(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isSignal(value: unknown): value is DeliverabilitySignal {
	if (!isRecord(value)) return false;
	const provider = value['provider'];
	const source = value['source'];
	const severity = value['severity'];
	return (
		(provider === 'all' || isDestinationProviderKey(provider)) &&
		(source === 'ip_quarantined' ||
			source === 'dnsbl_listed' ||
			source === 'breaker_open' ||
			source === 'persistent_defers') &&
		(severity === 'warning' || severity === 'critical') &&
		typeof value['observedAt'] === 'number' &&
		Number.isFinite(value['observedAt']) &&
		value['observedAt'] >= 0
	);
}

/** Strict parser for the authenticated MTA routing-signal snapshot. */
export function normalizeDeliverabilityRoutingSnapshot(
	value: unknown
): DeliverabilityRoutingSnapshot | null {
	if (
		!isRecord(value) ||
		typeof value['generatedAt'] !== 'number' ||
		!Number.isFinite(value['generatedAt']) ||
		value['generatedAt'] < 0 ||
		!Array.isArray(value['signals']) ||
		value['signals'].length > MAX_SIGNALS ||
		!value['signals'].every(isSignal)
	) {
		return null;
	}
	return {
		generatedAt: value['generatedAt'],
		signals: value['signals'].map((signal) => ({ ...signal })),
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
