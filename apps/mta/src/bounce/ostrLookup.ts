/**
 * OSTR tier lookups for the inbound path (plan §12.2).
 *
 * The registry answers one question — "what does the federation say about this
 * sender?" — and this module is the MTA's policy around asking it. The asking
 * itself belongs to `@owlat/ostr-client`: {@link OstrTierResolver} is that
 * package's `OstrClient`, which resolves a subject out of the local signed
 * snapshot first and only falls back to a DNS query for a subject the snapshot
 * has no entry for. That order is a privacy rule, not a performance one (spec
 * 08 §8.3), and it is the client's, not ours — see `ostrClient.ts` for how the
 * snapshot gets there.
 *
 * The policy is four rules, and all four are load-bearing:
 *
 *   1. NO SIGNAL, NO LOOKUPS. With `OSTR_ENABLED` off (the default) or nothing
 *      configured to ask, there is no client and nothing here queries anything.
 *      An instance that has not chosen an aggregator must not publish its
 *      correspondents to one.
 *   2. FAIL-OPEN, ALWAYS. Every outcome that is not a parsed answer — timeout,
 *      SERVFAIL, malformed record, two records at one name — ends as "no OSTR
 *      fields on the payload". This matches the ClamAV precedent on this path: a
 *      scanner that cannot answer does not get to hold up the mail.
 *   3. BOUNDED. Every lookup is wrapped in `OSTR_LOOKUP_TIMEOUT_MS`, and the
 *      per-message path issues AT MOST ONE of them (the domain's). The IP half
 *      runs once per CONNECTION, from `onConnect`, so a message never waits on
 *      two lookups in series — plan §12.2's "IP tier consulted at connection
 *      time".
 *   4. `error` IS NOT A VERDICT. Spec 08 §8.1 is explicit that a failed lookup
 *      is a fact about the lookup and MUST NOT be read as a fact about the
 *      subject, so a domain lookup that ERRORED does not fall through to the
 *      connecting IP's standing. Only a domain nobody has evidence about does.
 *      Otherwise one SERVFAIL would report a `trusted` sender on a shared cloud
 *      IP as `flagged`.
 *
 * The tier is never a gate. Nothing in this module returns a verdict, an SMTP
 * reply, or a reason to reject: the answer travels to Convex on the mailbox
 * payload as a signal beside SPF/DKIM/DMARC, and the reader decides what to
 * show. Making it a gate would hand any aggregator a veto over a receiver's
 * mail — the failure mode §9 exists to prevent.
 */

import {
	canonicalIp,
	normalizeDomainName,
	type SubjectRef,
	type Tier,
	type TierResult,
} from '@owlat/ostr-client';
import type { MtaConfig } from '../config.js';
import { normalizeIp } from './inboundSecurity.js';
import { logger } from '../monitoring/logger.js';

/** The config slice the lookups read — nothing else of `MtaConfig` is consulted. */
export type OstrLookupConfig = Pick<MtaConfig, 'ostrEnabled' | 'ostrLookupTimeoutMs'>;

/** What the MX keeps from an answer: the tier and the score behind it. */
export interface OstrSignal {
	readonly tier: Tier;
	readonly score: number;
}

/**
 * A lookup outcome, keeping the two failure kinds apart because the caller
 * must: `none` is a fact about the SUBJECT (nobody has evidence), `error` is a
 * fact about the LOOKUP and says nothing at all about the sender.
 */
export type OstrLookupOutcome =
	| { readonly status: 'answer'; readonly signal: OstrSignal }
	| { readonly status: 'none' }
	| { readonly status: 'error' };

const NO_EVIDENCE: OstrLookupOutcome = { status: 'none' };
const LOOKUP_FAILED: OstrLookupOutcome = { status: 'error' };

/**
 * The consumer client this module drives — structurally `OstrClient` from
 * `@owlat/ostr-client`, narrowed to the one method used so tests can hand in a
 * stub without building a snapshot store.
 */
export interface OstrTierResolver {
	resolveTier(subject: SubjectRef): Promise<TierResult>;
}

/** Everything a lookup needs: the operator's choices plus the client, if any. */
export interface OstrLookupDeps {
	readonly config: OstrLookupConfig;
	/** `null` when the instance consumes no registry — then nothing is asked. */
	readonly client: OstrTierResolver | null;
}

/**
 * Resolve `promise` or give up after `timeoutMs`.
 *
 * The timer is cleared on every exit so a slow resolver cannot keep the event
 * loop alive past the message it belonged to; the losing promise is left to
 * settle unobserved, which is fine because nothing downstream reads it.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('OSTR lookup timeout')), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/**
 * Rule 1, in one predicate: with the signal off, or nothing configured to ask,
 * every entry point returns before it so much as parses the subject.
 */
function consumesRegistry(deps: OstrLookupDeps): boolean {
	return deps.config.ostrEnabled && deps.client !== null;
}

/**
 * One tier lookup for one subject. Never throws and never rejects: a timeout or
 * a resolver that blew up is reported as `error`, which every caller treats as
 * "the message is delivered exactly as it would have been without OSTR".
 */
async function lookupTier(deps: OstrLookupDeps, subject: SubjectRef): Promise<OstrLookupOutcome> {
	const { client, config } = deps;
	if (client === null) {
		return NO_EVIDENCE;
	}

	try {
		const result = await withTimeout(client.resolveTier(subject), config.ostrLookupTimeoutMs);
		if (result.status === 'answer') {
			return { status: 'answer', signal: { tier: result.answer.tier, score: result.answer.score } };
		}
		if (result.status === 'none') {
			// The common case (an unscored sender) — not worth a warn line per
			// message on a busy MX.
			logger.debug({ subject }, 'OSTR: no evidence for subject');
			return NO_EVIDENCE;
		}
		logger.debug({ subject, errors: result.errors }, 'OSTR tier lookup failed');
		return LOOKUP_FAILED;
	} catch (err) {
		// Timeout, or a client that rejected outside its own handling.
		logger.debug({ err, subject }, 'OSTR tier lookup failed');
		return LOOKUP_FAILED;
	}
}

/**
 * Tier for a sending domain. A name that could not be a DNS name is not a
 * subject, so it is `none` rather than an error worth reporting.
 */
export function lookupOstrDomainTier(
	deps: OstrLookupDeps,
	domain: string
): Promise<OstrLookupOutcome> {
	if (!consumesRegistry(deps)) {
		return Promise.resolve(NO_EVIDENCE);
	}
	const name = normalizeDomainName(domain);
	if (name === null) {
		return Promise.resolve(NO_EVIDENCE);
	}
	return lookupTier(deps, { domain: name });
}

/**
 * Tier for a connecting IP.
 *
 * The address is folded through {@link normalizeIp} FIRST. A dual-stack
 * listener reports a v4 peer as `::ffff:203.0.113.10`, and the query-name rule
 * (`ipQueryName`, `@owlat/ostr-core`) expands that spelling into the 32-nibble
 * IPv6 name instead of `10.113.0.203.ip.q.<zone>` — a name no aggregator
 * publishes, so every IP lookup on a deployed MX would be a permanent NXDOMAIN
 * and nothing would say so. The same fold keys the connection limiter
 * (`inboundSecurity.ts`) and the loopback check (`serverHelpers.ts`).
 */
export function lookupOstrIpTier(deps: OstrLookupDeps, ip: string): Promise<OstrLookupOutcome> {
	if (!consumesRegistry(deps)) {
		return Promise.resolve(NO_EVIDENCE);
	}
	const address = canonicalIp(normalizeIp(ip));
	if (address === null) {
		return Promise.resolve(NO_EVIDENCE);
	}
	return lookupTier(deps, { ip: address.literal });
}

/** The identities an inbound message offers the registry, best first. */
export interface OstrSubjectHints {
	/** `d=` of the signature the message is judged on, when one verified. */
	readonly dkimSigningDomain?: string;
	/**
	 * The connection's IP lookup, started in `onConnect` and normally settled
	 * long before DATA. Awaiting it here costs nothing on the message path and
	 * cannot exceed the same per-lookup timeout, which started at connect.
	 */
	readonly connectionIpTier?: Promise<OstrLookupOutcome>;
}

/**
 * The signal for one inbound message: the DKIM-authenticated domain's tier if
 * there is one, else the connecting IP's.
 *
 * Domain-first is not a preference, it is the identity rule (plan D2): a domain
 * is a claim the sender proved with a signature, while an IP is a shared, often
 * rented, position. Only a `d=` that VERIFIED is used, so this cannot be moved
 * by an unsigned header.
 *
 * The IP is consulted when the domain produced NO EVIDENCE, or when there was
 * no signature to ask about — never when the domain lookup FAILED, because
 * substituting the IP's standing there would report a lookup accident as the
 * sender's reputation (spec 08 §8.1, rule 4 in the module doc).
 */
export async function resolveOstrSignal(
	deps: OstrLookupDeps,
	hints: OstrSubjectHints
): Promise<OstrSignal | null> {
	if (!consumesRegistry(deps)) {
		return null;
	}
	if (hints.dkimSigningDomain !== undefined && hints.dkimSigningDomain !== '') {
		const byDomain = await lookupOstrDomainTier(deps, hints.dkimSigningDomain);
		if (byDomain.status === 'answer') {
			return byDomain.signal;
		}
		if (byDomain.status === 'error') {
			return null;
		}
	}
	if (hints.connectionIpTier === undefined) {
		return null;
	}
	// `lookupOstrIpTier` does not reject; the catch is here so a caller that
	// hands in some other promise still cannot take the message down with it.
	const byIp = await hints.connectionIpTier.catch(() => LOOKUP_FAILED);
	return byIp.status === 'answer' ? byIp.signal : null;
}
