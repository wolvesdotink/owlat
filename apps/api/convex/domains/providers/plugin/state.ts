/**
 * From "what a bundled plugin said" to "what the identity row holds" — the pure
 * half of the plugin sending-domain provider (the seams plan's P3.2).
 *
 * Its own file for the same reason `../mandrill/identity.ts` is: every rule here
 * is a JUDGEMENT that must be pinned by a test rather than exercised through a
 * network mock — what counts as verified, how often we ask again, and what a
 * failed call is allowed to overwrite.
 *
 * WHAT DIFFERS FROM THE CORE ADAPTERS is that the input is UNTRUSTED. Mandrill's
 * `identity.ts` reads a shape its own `api.ts` parsed out of a response we
 * decided how to read; this reads whatever a third-party module returned. So
 * every field is re-validated here, bounded here, and the STATUS is derived here
 * — a module cannot report a domain verified while telling us its DKIM record is
 * invalid, because it does not get to report a status at all.
 */

import {
	PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACT_LENGTH,
	PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS,
	PLUGIN_DOMAIN_IDENTITY_MAX_ERROR_LENGTH,
} from '@owlat/plugin-kit';
import type { RelayIdentityStatus } from '../types';

/**
 * How long an observation still licenses handing a From domain to this relay.
 *
 * A HOST CONSTANT, not a manifest field, and that is the piece's one
 * non-negotiable declaration. This bound is what limits the blast radius of an
 * identity revoked, suspended or deleted at the provider while our row survives:
 * nothing in the stored state distinguishes "still fine" from "removed an hour
 * ago", so the only thing that ever retires a stale proof is its age. A
 * declarable window would be a declarable weakening of exactly that.
 *
 * Seven days, matching `MANDRILL_RELAY_PROOF_MAX_AGE_MS` — the re-check cadence
 * below keeps a live proof far inside it, so the bound only ever bites when the
 * sweep has been unable to confirm for a week.
 */
export const PLUGIN_RELAY_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The re-check cadence, by the state we last observed — the same shape and the
 * same reasoning as Mandrill's.
 *
 * `verified` is daily, which keeps a proof inside the bound above with six days
 * of headroom for missed ticks. `pending_dns` is hourly because it is the state
 * an operator is actively working in. `failed` is slow on purpose: it means a
 * credential someone has to fix, and re-asking hard would hammer a provider's
 * auth surface with a key it already rejected.
 */
export const PLUGIN_CHECK_INTERVAL_MS = {
	verified: 24 * 60 * 60 * 1000,
	pending_dns: 60 * 60 * 1000,
	unverified: 60 * 60 * 1000,
	failed: 6 * 60 * 60 * 1000,
} as const satisfies Record<RelayIdentityStatus, number>;

/**
 * Retry delay after a call that told us NOTHING (provider down, timeout, a
 * module that threw). Shorter than any real cadence: there is no new information
 * to wait for, only an outage to ride out.
 */
export const PLUGIN_UNAVAILABLE_RETRY_MS = 15 * 60 * 1000;

/** One record verdict, as the host keeps it. */
export type PluginRecordVerdict = {
	readonly isValid: boolean;
	readonly error?: string;
};

/**
 * A validated observation. The shape the row is written from, and the only shape
 * anything downstream of the boundary sees.
 */
export type PluginRelayObservation = {
	readonly status: RelayIdentityStatus;
	readonly spf: PluginRecordVerdict;
	readonly dkim: PluginRecordVerdict;
	readonly dkimSelectors: readonly string[];
	readonly spfMechanisms: readonly string[];
};

/** What one identity call produced, after the host has read it. */
export type PluginRelayCallOutcome =
	| { readonly outcome: 'ok'; readonly observation: PluginRelayObservation }
	| { readonly outcome: 'auth_failed'; readonly error: string }
	| { readonly outcome: 'unavailable'; readonly error: string };

/** The `providerDetails` blob for a plugin identity (D7, versioned). */
export interface PluginRelayProviderDetails {
	readonly kind: 'plugin';
	/** The DNS the alignment pre-flight resolves for this domain's second arm. */
	readonly dkimSelectors: readonly string[];
	readonly spfMechanisms: readonly string[];
	/** Why the last call could not produce a verdict, when it could not. */
	readonly lastError?: string;
}

/**
 * Read a module's return value into an outcome the host can act on.
 *
 * A SHAPE WE DO NOT RECOGNISE IS `unavailable`, never a verdict. The three
 * outcomes differ in what they are allowed to overwrite — only `ok` refreshes
 * the proof's age, only `auth_failed` condemns a credential — so a malformed
 * response has to land on the one that changes nothing but the retry. Reading it
 * as `ok` would let a module that returns `{}` mark a domain unverified and
 * simultaneously refresh the freshness clock; reading it as `auth_failed` would
 * blame an operator's credential for a plugin's bug.
 */
export function parsePluginRelayResult(input: unknown): PluginRelayCallOutcome {
	if (!isRecord(input)) return unavailable('identity module returned a non-object');
	const outcome = input['outcome'];
	if (outcome === 'auth_failed' || outcome === 'unavailable') {
		const error = boundedText(input['error']) ?? 'no detail reported';
		return outcome === 'auth_failed' ? { outcome, error } : { outcome, error };
	}
	if (outcome !== 'ok') return unavailable('identity module returned an unknown outcome');
	const state = input['state'];
	if (!isRecord(state)) return unavailable('identity module returned no state');
	const spf = parseVerdict(state['spf']);
	const dkim = parseVerdict(state['dkim']);
	if (!spf || !dkim) return unavailable('identity module returned no record verdicts');
	if (typeof state['isOwnershipVerified'] !== 'boolean') {
		return unavailable('identity module returned no ownership verdict');
	}
	const dkimSelectors = parseDnsFacts(state['dkimSelectors']);
	const spfMechanisms = parseDnsFacts(state['spfMechanisms']);
	return {
		outcome: 'ok',
		observation: {
			// DERIVED, never declared — see the file header. THREE conditions, and the
			// ownership one is not redundant: a provider will happily report perfect
			// SPF and DKIM for a domain whose ownership ceremony never completed, and
			// then reject the mail. `unverified` rather than `pending_dns` when the
			// module could not describe the DNS at all, because there is then nothing
			// for an operator to be waiting on.
			status: relayStatusFor(state['isOwnershipVerified'], spf, dkim, dkimSelectors),
			spf,
			dkim,
			dkimSelectors,
			spfMechanisms,
		},
	};
}

function relayStatusFor(
	isOwnershipVerified: boolean,
	spf: PluginRecordVerdict,
	dkim: PluginRecordVerdict,
	dkimSelectors: readonly string[]
): RelayIdentityStatus {
	if (isOwnershipVerified && spf.isValid && dkim.isValid && dkimSelectors.length > 0) {
		return 'verified';
	}
	return dkimSelectors.length > 0 ? 'pending_dns' : 'unverified';
}

/** The versioned blob one observation is stored as. */
export function buildPluginProviderDetails(
	observation: PluginRelayObservation
): PluginRelayProviderDetails {
	return {
		kind: 'plugin',
		dkimSelectors: observation.dkimSelectors,
		spfMechanisms: observation.spfMechanisms,
	};
}

/** The DNS facts a stored blob holds, or empty when it holds none we can read. */
export function readPluginProviderDetails(raw: string | undefined): {
	readonly dkimSelectors: readonly string[];
	readonly spfMechanisms: readonly string[];
} {
	if (raw === undefined) return { dkimSelectors: [], spfMechanisms: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { dkimSelectors: [], spfMechanisms: [] };
	}
	if (!isRecord(parsed)) return { dkimSelectors: [], spfMechanisms: [] };
	return {
		dkimSelectors: parseDnsFacts(parsed['dkimSelectors']),
		spfMechanisms: parseDnsFacts(parsed['spfMechanisms']),
	};
}

/** When to ask again, given what we last saw. */
export function nextPluginCheckDueAt(status: RelayIdentityStatus, checkedAt: number): number {
	return checkedAt + PLUGIN_CHECK_INTERVAL_MS[status];
}

function unavailable(error: string): PluginRelayCallOutcome {
	return { outcome: 'unavailable', error };
}

function parseVerdict(input: unknown): PluginRecordVerdict | null {
	if (!isRecord(input) || typeof input['isValid'] !== 'boolean') return null;
	const error = boundedText(input['error']);
	return error === undefined ? { isValid: input['isValid'] } : { isValid: input['isValid'], error };
}

/**
 * DKIM selectors / SPF mechanisms, bounded in count and length.
 *
 * These are RESOLVED LIVE by the alignment pre-flight, so an unbounded list is an
 * unbounded number of DNS lookups per domain per sweep, driven by a manifest.
 * A malformed list yields the empty one, which reads downstream as "we cannot
 * describe this domain's signing identity" — a HOLD on the ramp, never an opened
 * gate.
 */
function parseDnsFacts(input: unknown): readonly string[] {
	if (!Array.isArray(input)) return [];
	const facts: string[] = [];
	for (const item of input) {
		if (typeof item !== 'string') continue;
		const trimmed = item.trim();
		if (trimmed.length === 0 || trimmed.length > PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACT_LENGTH) {
			continue;
		}
		if (facts.includes(trimmed)) continue;
		facts.push(trimmed);
		if (facts.length === PLUGIN_DOMAIN_IDENTITY_MAX_DNS_FACTS) break;
	}
	return Object.freeze(facts);
}

/** Provider free text, truncated — it reaches an operator log line and nothing else. */
function boundedText(input: unknown): string | undefined {
	if (typeof input !== 'string') return undefined;
	const trimmed = input.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, PLUGIN_DOMAIN_IDENTITY_MAX_ERROR_LENGTH);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
