/**
 * The `bl.` / `wl.` compatibility views (spec 08 §8.1): the A-record answers
 * stock MTA blocklist machinery already knows how to consume.
 *
 * This module exists so an Owlat MTA can read the same views a Postfix
 * `reject_rbl_client` line reads, and so the query names this client builds are
 * pinned by tests next to the ones the aggregator's zone generator emits. It is
 * a compatibility surface, not the rich path: an A record carries a listing,
 * not a score, and a caller that wants tier and evidence wants
 * {@link lookupTierViaDns} or the snapshot.
 *
 * Name form, matching the DNSBL/DNSWL convention exactly, because "no MTA code
 * changes" is the whole point of these views:
 *
 * ```
 * 4.3.2.1.bl.ostr.example        # IPv4, reversed by octet
 * <32 nibbles>.bl.ostr.example   # IPv6, reversed by nibble
 * example.com.wl.ostr.example    # domain, RHSBL style
 * ```
 *
 * Note the missing `ip.` label: the TXT zone puts IP names under `ip.q.<zone>`
 * (`ipQueryName`), but stock RBL clients query the reversed address directly
 * under the view's zone, so that is what these names use. The reversal itself
 * still comes from `@owlat/ostr-core`.
 */

import { ipQueryName, type SubjectRef } from '@owlat/ostr-core';
import { canonicalIp, normalizeDomainName } from './subject.js';

/** Resolves A records for `name` to IPv4 literals (`dns.promises.resolve4`). */
export type ResolveA = (name: string) => Promise<string[]>;

/** `bl` lists `flagged` subjects; `wl` lists `trusted` ones. */
export type RblView = 'bl' | 'wl';

export interface RblLookupInput {
	subject: SubjectRef;
	view: RblView;
	/** Aggregator zone apex, e.g. `ostr.example`. The view label is added here. */
	zone: string;
	resolveA: ResolveA;
}

export type RblLookupResult =
	| { status: 'listed'; name: string; addresses: string[] }
	| { status: 'not-listed'; name: string }
	| { status: 'error'; name: string; errors: string[] };

const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

function errorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * True for the `127.0.0.0/8` answers the DNSBL convention reserves for
 * listings. Every octet is range-checked, so `127.999.0.1` — which is not an
 * address at all — is not read as a listing.
 */
export function isLoopbackAnswer(address: string): boolean {
	const octets = address.trim().split('.');
	if (octets.length !== 4 || octets[0] !== '127') return false;
	return octets.every((octet) => {
		if (!/^\d{1,3}$/.test(octet)) return false;
		return Number(octet) <= 255;
	});
}

/**
 * Arbitrary but fixed placeholder zone, so the suffix this strips is a constant
 * of this module rather than a function of the caller's zone string.
 */
const REVERSAL_PROBE = 'invalid';
const REVERSAL_SUFFIX = `.ip.q.${REVERSAL_PROBE}`;

/**
 * The reversed labels of an address — IPv4 octets, IPv6 nibbles — without the
 * TXT zone's `ip.q.<zone>` suffix.
 *
 * The reversal itself is core's; this only removes the suffix core appends, and
 * it asserts the suffix was there. Silently producing a malformed query name if
 * core ever changes the TXT name layout would turn a wire-format change into
 * "the compatibility views quietly stop matching", which is the worst way to
 * find out.
 *
 * KNOWN DUPLICATE, kept deliberately identical to `reversedIp()` in the
 * registry's `aggregator/zone.ts` — same probe, same guard, so the two copies
 * cannot drift into disagreeing about a name and a future core primitive
 * replaces both with the same deletion. The wave report carries the request for
 * `@owlat/ostr-core` to export a `reversedIpLabels(ip)` (the reversal with no
 * zone suffix at all); that package is frozen this wave, and a client that
 * cannot query the compat views is worse than one carrying eight lines twice.
 */
function reversedIpLabels(literal: string): string {
	const name = ipQueryName(literal, REVERSAL_PROBE);
	if (!name.endsWith(REVERSAL_SUFFIX)) {
		throw new Error(`ipQueryName no longer ends with ${REVERSAL_SUFFIX}: ${name}`);
	}
	return name.slice(0, -REVERSAL_SUFFIX.length);
}

/**
 * The compatibility-view name for a subject, or `null` when the reference
 * names neither a domain nor a parseable address.
 */
export function rblQueryName(subject: SubjectRef, view: RblView, zone: string): string | null {
	const domain = normalizeDomainName(subject.domain);
	if (domain !== null) return `${domain}.${view}.${zone}`;
	const ip = canonicalIp(subject.ip);
	if (ip === null) return null;
	return `${reversedIpLabels(ip.literal)}.${view}.${zone}`;
}

/**
 * Look a subject up in a compatibility view.
 *
 * An answer outside `127.0.0.0/8` is an error, not a listing: blocklists use
 * such answers to signal "your resolver is blocked" or "query refused", and
 * treating one as a hit would let a broken or hostile upstream reject a
 * sender's mail wholesale.
 */
export async function rblLookup(input: RblLookupInput): Promise<RblLookupResult> {
	const name = rblQueryName(input.subject, input.view, input.zone);
	if (name === null) {
		return {
			status: 'error',
			name: '',
			errors: ['subject names neither a domain nor a parseable IP'],
		};
	}

	let addresses: string[];
	try {
		addresses = await input.resolveA(name);
	} catch (error: unknown) {
		const code = errorCode(error);
		if (code !== null && NOT_FOUND_CODES.has(code)) return { status: 'not-listed', name };
		return { status: 'error', name, errors: [`resolver failed: ${errorMessage(error)}`] };
	}

	if (!Array.isArray(addresses) || addresses.length === 0) return { status: 'not-listed', name };
	const listed = addresses.filter(isLoopbackAnswer);
	if (listed.length === 0) {
		return {
			status: 'error',
			name,
			errors: [`answer outside 127.0.0.0/8: ${addresses.join(', ')}`],
		};
	}
	return { status: 'listed', name, addresses: listed };
}
