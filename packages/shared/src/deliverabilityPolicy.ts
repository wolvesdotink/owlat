import type { DestinationProviderKey } from './deliverabilityRouting';
import type { OutboundTlsMode } from './outboundTlsMode';

/**
 * Deliverability policy shared by the MTA, API, and operational documentation.
 *
 * Receiver requirements and Owlat's internal protection thresholds are named
 * separately so callers cannot accidentally present an internal breaker as a
 * mailbox-provider rule.
 */
const HOUR_MS = 60 * 60 * 1000;

export const GMAIL_BULK_SENDER_THRESHOLD = 5_000;
export const GMAIL_PROXIMITY_WARNING_THRESHOLD = 4_000;
export const MICROSOFT_HIGH_VOLUME_SENDER_THRESHOLD = 5_000;
export const UNSUBSCRIBE_HONOR_WINDOW_MS = 48 * HOUR_MS;

export const CIRCUIT_BREAKER_POLICY = Object.freeze({
	bounce: Object.freeze({
		fast: Object.freeze({ windowSize: 50, rateExclusiveMax: 0.15 }),
		sustained: Object.freeze({ windowSize: 100, rateExclusiveMax: 0.08 }),
	}),
	complaint: Object.freeze({
		fast: Object.freeze({ windowSize: 50, rateExclusiveMax: 0.04 }),
		sustained: Object.freeze({ windowSize: 100, rateExclusiveMax: 0.002 }),
	}),
	cooldownMs: 30 * 60 * 1000,
});

export const CAMPAIGN_COMPLAINT_POLICY = Object.freeze({
	rateExclusiveMax: 0.003,
	minimumDeliveries: 100,
});

export interface DestinationProviderProfile {
	/** Default sending rate in emails per minute. */
	defaultRate: number;
	/** Maximum adaptive rate ceiling. */
	ceiling: number;
	/** Minimum adaptive rate floor. */
	floor: number;
	/** Multiplier applied after a temporary receiver failure. */
	backoffFactor: number;
	/** Multiplier applied after sustained success. */
	recoveryFactor: number;
	/** Provider TLS floor composed with local, MTA-STS, and DANE policy. */
	tlsMode: OutboundTlsMode;
	/** Maximum live SMTP connection lineages for this provider. */
	maxConnections: number;
	/** Deliveries allowed over one connection before a clean recycle. */
	maxDeliveriesPerConnection: number;
}

/**
 * The rows the checked-in shaping table is total over: every NAMED cell of the
 * destination taxonomy, plus the generic row every other destination reads.
 *
 * `other` is deliberately absent. It is the taxonomy's UNNAMED cell, and
 * `__default__` is the row that shapes it: `canonicalProfileKey` leaves an
 * operator outside the taxonomy on its OWN domain key, so `getProfile` finds no
 * checked-in entry and falls through to `mta:isp-profile:__default__` — the
 * Redis row seeded from this table's `__default__` values. Giving `other` a row
 * here would produce `mta:isp-profile:other`, which that read path never
 * consults, so it would shape nothing while looking like it shaped everything
 * unnamed.
 */
type CheckedInProfileKey = Exclude<DestinationProviderKey, 'other'> | '__default__';

/**
 * Checked-in startup defaults; runtime operator overrides remain authoritative.
 *
 * TOTAL OVER THE TAXONOMY (D8), in BOTH directions. The explicit type argument
 * on `Object.freeze` is what makes the object literal below checked against
 * `CheckedInProfileKey` while it is still fresh, so a MISSING row and a STALE
 * row are each a build failure: add a key to `DESTINATION_PROVIDER_KEYS` and
 * this stops compiling until that provider gets a considered shaping row
 * (instead of silently falling through to `__default__`, 30/min, opportunistic
 * TLS, everywhere `getProfile` reads); remove or rename one and its orphaned
 * row stops compiling too (instead of being HSETNX-ed into Redis by
 * `seedProfiles` every boot forever). A trailing `satisfies` would only catch
 * the first: freshness — and with it excess-property checking — is lost through
 * the `Object.freeze` call.
 *
 * The EXPORTED alias below is string-keyed on purpose: `config/ispProfiles.ts`
 * looks profiles up by `canonicalProfileKey`, which is deliberately a raw
 * DOMAIN for operators outside the taxonomy (the pinned divergence documented
 * there), and the docs table iterates the object's own entries. Both are
 * legitimate string reads of a table whose membership is nonetheless
 * exhaustively checked here.
 */
const CHECKED_IN_DESTINATION_PROVIDER_PROFILES = Object.freeze<
	Readonly<Record<CheckedInProfileKey, Readonly<DestinationProviderProfile>>>
>({
	gmail: Object.freeze({
		defaultRate: 100,
		ceiling: 300,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
		tlsMode: 'require',
		maxConnections: 5,
		maxDeliveriesPerConnection: 50,
	}),
	microsoft: Object.freeze({
		defaultRate: 80,
		ceiling: 200,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
		tlsMode: 'opportunistic',
		maxConnections: 3,
		maxDeliveriesPerConnection: 100,
	}),
	yahoo: Object.freeze({
		defaultRate: 50,
		ceiling: 150,
		floor: 3,
		backoffFactor: 0.4,
		recoveryFactor: 1.05,
		tlsMode: 'opportunistic',
		maxConnections: 3,
		maxDeliveriesPerConnection: 100,
	}),
	apple: Object.freeze({
		defaultRate: 60,
		ceiling: 150,
		floor: 5,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
		tlsMode: 'opportunistic',
		maxConnections: 3,
		maxDeliveriesPerConnection: 100,
	}),
	__default__: Object.freeze({
		defaultRate: 30,
		ceiling: 100,
		floor: 2,
		backoffFactor: 0.5,
		recoveryFactor: 1.1,
		tlsMode: 'opportunistic',
		maxConnections: 3,
		maxDeliveriesPerConnection: 100,
	}),
});

export const DESTINATION_PROVIDER_PROFILES: Readonly<
	Record<string, Readonly<DestinationProviderProfile>>
> = CHECKED_IN_DESTINATION_PROVIDER_PROFILES;
