'use node';

/**
 * MTA-STS publication verifier (RFC 8461) — the LIVE gather half of the
 * deployment's own MTA-STS surface. Split out of `domains/dnsVerification.ts`
 * (file-size rule) and separate from the `domains/mtaSts.ts` policy queries
 * because it needs `node:dns` + `fetch` and must be a `'use node'` module
 * (Convex forbids queries/mutations in a Node runtime module).
 *
 * `verifyReceivingMtaSts` checks that our OWN MTA-STS policy is correctly
 * published for `domain`: the `_mta-sts.<domain>` TXT record must carry our
 * current policy id AND `https://mta-sts.<domain>/.well-known/mta-sts.txt` must
 * serve the exact policy body we generate. The expected policy is read from the
 * same `getMtaStsPolicy` query the public route serves, so "what we verify"
 * can't drift from "what we publish". The id-match verdict is the pure,
 * unit-tested `verifyMtaStsPublication`; this action only gathers the raw DNS +
 * HTTPS observations and never throws — a lookup/fetch failure degrades to a
 * "not found" observation so the setup UI shows "not verified", not an error.
 *
 * The DNS + HTTPS calls are injected via {@link MtaStsGatherDeps} (mirroring the
 * `ReverseDnsDeps` pattern) so the SSRF guard, fail-soft nulls, RFC 1035 chunk
 * joining and the streamed size cap are unit-testable without a real network.
 */

import { v } from 'convex/values';
import { api } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import {
	MTA_STS_TXT_HOST,
	MTA_STS_POLICY_HOST,
	MTA_STS_WELL_KNOWN_PATH,
	verifyMtaStsPublication,
} from '@owlat/shared/mtaStsPolicy';
import type { MtaStsVerification } from '@owlat/shared/mtaStsPolicy';
import { isValidDomain } from '@owlat/shared';
import { readCappedBytes, CappedReadOverflow } from '../lib/ssrfGuard';

// A published MTA-STS policy body is a handful of short lines; anything larger is
// not a policy we can meaningfully compare, so we cap the HTTPS read to bound
// memory. The cap is enforced WHILE STREAMING (running byte count) so a hostile
// or slow-drip host can't buffer hundreds of MB inside the timeout window.
const MTA_STS_POLICY_MAX_BYTES = 64 * 1024;
// Hard ceiling on the policy fetch so a hostile or unresponsive host on the
// operator-supplied domain can't hang the verify action (mirrors the
// AbortSignal.timeout guards on the other outbound fetches in this backend).
const MTA_STS_FETCH_TIMEOUT_MS = 10_000;

/** Injected DNS + HTTPS primitives so the gather is testable without a network. */
export interface MtaStsGatherDeps {
	/** Resolve a TXT record to its raw chunk arrays (per `node:dns` `resolveTxt`). */
	resolveTxt(name: string): Promise<string[][]>;
	/** Resolve every address for a host (per `node:dns` `lookup({ all: true })`). */
	lookup(host: string): Promise<{ address: string }[]>;
	/**
	 * Fetch a URL. Declared structurally (not `typeof fetch`) so the interface
	 * doesn't inherit the global's extra members (e.g. Bun's `fetch.preconnect`),
	 * which would trip strict typecheck under apps/web's lib set. Every call site
	 * and test fake satisfies this shape.
	 */
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

const defaultDeps: MtaStsGatherDeps = {
	resolveTxt: (name) => dns.resolveTxt(name),
	lookup: (host) => dns.lookup(host, { all: true }),
	fetch: (input, init) => fetch(input, init),
};

// Live verification that our OWN MTA-STS policy is correctly published for
// `domain`. Returns `null` when no policy is being published (`mode === 'none'`
// or no mail host), matching `getMtaStsPolicy`.
//
// authz: admin-gated — the underlying `getMtaStsGuidance`/verify are operator
// tasks; the floor is `organization:manage` (checked in `getMtaStsGuidance`).
export const verifyReceivingMtaSts = authedAction({
	args: { domain: v.string() },
	handler: async (ctx, args): Promise<MtaStsVerification | null> => {
		// Admin gate + published-policy check in one query the route also uses.
		await ctx.runQuery(api.domains.mtaSts.getMtaStsGuidance, {});
		const expected = await ctx.runQuery(api.domains.mtaSts.getMtaStsPolicy, {});
		if (!expected) return null;

		const txtValue = await resolveMtaStsTxt(args.domain);
		const servedBody = await fetchMtaStsPolicyBody(args.domain);
		return verifyMtaStsPublication(
			{ policyId: expected.policyId, body: expected.body },
			{ txtValue, servedBody }
		);
	},
});

// Resolve the `_mta-sts.<domain>` TXT record, joining multi-string chunks per
// RFC 1035. Fail-soft: a malformed domain or any lookup error → null (treated as
// "no record"). `domain` is validated before it reaches the DNS name so a bogus
// value can't smuggle extra labels into the query.
export async function resolveMtaStsTxt(
	domain: string,
	deps: MtaStsGatherDeps = defaultDeps
): Promise<string | null> {
	if (!isValidDomain(domain)) return null;
	try {
		const records = await deps.resolveTxt(`${MTA_STS_TXT_HOST}.${domain}`);
		const joined = records.map((chunks) => chunks.join(''));
		return joined.find((value) => value.toLowerCase().includes('v=stsv1')) ?? joined[0] ?? null;
	} catch {
		return null;
	}
}

// Fetch the HTTPS-served policy body from `mta-sts.<domain>`. Fail-soft: a
// malformed domain, any non-2xx, redirect, timeout, oversized body or network
// error → null (treated as "not served"). SSRF-disciplined: HTTPS only, no
// cross-host redirects (`redirect: 'error'`), a bounded timeout, a streamed
// body-size cap, `domain` validated so it can't inject userinfo/port/path into
// the request URL, AND the `mta-sts.<domain>` host is rejected when it resolves
// to a private/link-local/loopback address (public unicast only).
export async function fetchMtaStsPolicyBody(
	domain: string,
	deps: MtaStsGatherDeps = defaultDeps
): Promise<string | null> {
	if (!isValidDomain(domain)) return null;
	const host = `${MTA_STS_POLICY_HOST}.${domain}`;
	if (!(await resolvesToPublicAddress(host, deps))) return null;
	try {
		const url = `https://${host}${MTA_STS_WELL_KNOWN_PATH}`;
		const response = await deps.fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(MTA_STS_FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		// Reject early when the server advertises an oversized body…
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > MTA_STS_POLICY_MAX_BYTES) return null;
		// …and enforce the cap while streaming, so a lying/absent Content-Length
		// can't buffer hundreds of MB before the size check.
		return await readCappedText(response.body, MTA_STS_POLICY_MAX_BYTES);
	} catch {
		return null;
	}
}

// Read a response body stream up to `maxBytes` real bytes, returning the decoded
// text or `null` if there is no body or the stream exceeds the cap. Decodes over
// the shared capped-byte reader (an over-cap body is a soft "too big, ignore"
// here — not a policy we can compare — so the overflow is swallowed to null).
async function readCappedText(
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<string | null> {
	try {
		const bytes = await readCappedBytes(body, maxBytes);
		return bytes === null ? null : new TextDecoder().decode(bytes);
	} catch (err) {
		if (err instanceof CappedReadOverflow) return null;
		throw err;
	}
}

// True when every resolved address for `host` is a public unicast address.
// Fail-soft on a resolution error → false (treated as unreachable), and an
// empty result → false (nothing to fetch). Best-effort SSRF guard: `fetch`
// resolves independently, so this narrows the common misconfig/abuse case
// (a `mta-sts.<domain>` CNAME/A pointing at an internal host) rather than being
// a TOCTOU-proof barrier.
async function resolvesToPublicAddress(host: string, deps: MtaStsGatherDeps): Promise<boolean> {
	try {
		const addresses = await deps.lookup(host);
		if (addresses.length === 0) return false;
		return addresses.every((entry) => isPublicUnicastAddress(entry.address));
	} catch {
		return false;
	}
}

// Reject loopback, private (RFC 1918), link-local, CGNAT, unique-local (IPv6)
// and unspecified ranges — the addresses an SSRF probe would target.
export function isPublicUnicastAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isPublicIpv4(address);
	if (family === 6) return isPublicIpv6(address);
	return false;
}

function isPublicIpv4(address: string): boolean {
	const parts = address.split('.').map((part) => Number(part));
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return false; // this-net, RFC 1918, loopback
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
	if (a === 192 && b === 168) return false; // RFC 1918
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT (RFC 6598)
	if (a >= 224) return false; // multicast + reserved
	return true;
}

function isPublicIpv6(address: string): boolean {
	const lower = address.toLowerCase();
	if (lower === '::' || lower === '::1') return false; // unspecified, loopback
	if (lower.startsWith('fe80')) return false; // link-local
	if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // unique-local
	// IPv4-mapped (::ffff:a.b.c.d) — defer to the IPv4 rules.
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return isPublicIpv4(mapped[1]);
	return true;
}
