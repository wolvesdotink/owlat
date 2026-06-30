/**
 * Forward-Confirmed Reverse DNS (FCrDNS) self-check
 *
 * Verifies that each sending IP's PTR record forward-confirms back to that IP
 * AND matches the EHLO name the MTA announces from it. Receiving MTAs (notably
 * Gmail/Yahoo under their 2024 bulk-sender requirements) check exactly this; a
 * mismatch tanks deliverability silently. We run it at startup and WARN per
 * non-OK IP so misconfigured reverse DNS surfaces in the logs instead of in a
 * spam folder.
 *
 * References:
 *   - RFC 1912 §2.1  (every host's PTR must forward-confirm)
 *   - RFC 5321 §4.1.1.1 (EHLO must be the client's FQDN)
 *   - Gmail / Yahoo 2024 bulk sender PTR requirements
 */

import { resolve4, reverse } from 'dns/promises';
import type { MtaConfig } from '../config.js';
import { resolveEhloForIp } from '../config.js';
import { logger } from '../monitoring/logger.js';

/**
 * Reasons an IP can fail the FCrDNS self-check.
 *  - `no-ptr`: the IP has no PTR record at all.
 *  - `forward-mismatch`: the PTR name does not forward-resolve back to this IP.
 *  - `ehlo-mismatch`: the PTR forward-confirms but none of the names match the
 *    EHLO hostname we announce from this IP.
 *  - `lookup-error`: a transient DNS error (timeout, SERVFAIL) — reported but
 *    not treated as a hard failure since it may be temporary.
 */
export type FcrdnsFailureReason =
	| 'no-ptr'
	| 'forward-mismatch'
	| 'ehlo-mismatch'
	| 'lookup-error';

export interface FcrdnsResult {
	ip: string;
	ok: boolean;
	/** The PTR names resolved for the IP (lowercased), empty when none. */
	ptrNames: string[];
	/** The EHLO name(s) we expected the PTR to include. */
	expectedNames: string[];
	/** Present only when `ok` is false. */
	reason?: FcrdnsFailureReason;
}

/**
 * Injectable DNS dependencies so tests can stub resolution without real DNS.
 * Defaults to Node's `dns/promises`.
 */
export interface FcrdnsDeps {
	/** Reverse-resolve an IP to its PTR hostname(s). */
	reverse: (ip: string) => Promise<string[]>;
	/** Forward-resolve a hostname to its A records. */
	resolve4: (hostname: string) => Promise<string[]>;
}

const DEFAULT_DEPS: FcrdnsDeps = { reverse, resolve4 };

function normalizeName(name: string): string {
	// PTR names sometimes carry a trailing dot; normalize for comparison.
	return name.trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Verify Forward-Confirmed Reverse DNS for a single sending IP.
 *
 * OK when the IP has a PTR record that (a) forward-resolves to a set of A
 * records containing this IP and (b) at least one PTR name equals one of the
 * `expectedNames` (the EHLO hostname for this IP). Otherwise returns `ok:false`
 * with a `reason`.
 */
export async function verifyFcrdns(
	ip: string,
	expectedNames: string[],
	deps: FcrdnsDeps = DEFAULT_DEPS,
): Promise<FcrdnsResult> {
	const expected = expectedNames.map(normalizeName).filter(Boolean);

	let ptrNamesRaw: string[];
	try {
		ptrNamesRaw = await deps.reverse(ip);
	} catch (err: unknown) {
		const error = err as { code?: string };
		// ENOTFOUND/ENODATA = no PTR record exists for this IP.
		if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
			return { ip, ok: false, ptrNames: [], expectedNames: expected, reason: 'no-ptr' };
		}
		// Transient DNS failure — report but don't treat as a hard misconfig.
		return { ip, ok: false, ptrNames: [], expectedNames: expected, reason: 'lookup-error' };
	}

	const ptrNames = ptrNamesRaw.map(normalizeName).filter(Boolean);
	if (ptrNames.length === 0) {
		return { ip, ok: false, ptrNames, expectedNames: expected, reason: 'no-ptr' };
	}

	// Forward-confirm: at least one PTR name must resolve back to this IP.
	let forwardConfirmed = false;
	for (const name of ptrNames) {
		try {
			const addrs = await deps.resolve4(name);
			if (addrs.includes(ip)) {
				forwardConfirmed = true;
				break;
			}
		} catch {
			// Ignore — try the next PTR name.
		}
	}

	if (!forwardConfirmed) {
		return { ip, ok: false, ptrNames, expectedNames: expected, reason: 'forward-mismatch' };
	}

	// EHLO match: a forward-confirmed PTR name must equal the announced EHLO name.
	const ehloMatches = ptrNames.some((name) => expected.includes(name));
	if (!ehloMatches) {
		return { ip, ok: false, ptrNames, expectedNames: expected, reason: 'ehlo-mismatch' };
	}

	return { ip, ok: true, ptrNames, expectedNames: expected };
}

/**
 * Run the FCrDNS self-check across every configured sending IP and WARN once
 * per non-OK IP. Never throws — DNS misconfiguration must not block startup,
 * only surface in the logs. Returns the per-IP results for callers/tests.
 */
export async function runFcrdnsSelfCheck(
	config: Pick<MtaConfig, 'ipPools' | 'ehloHostname' | 'ehloHostnames'>,
	deps: FcrdnsDeps = DEFAULT_DEPS,
): Promise<FcrdnsResult[]> {
	const ips = [...new Set([...config.ipPools.transactional, ...config.ipPools.campaign])];
	const results: FcrdnsResult[] = [];

	for (const ip of ips) {
		const expected = resolveEhloForIp(config, ip);
		let result: FcrdnsResult;
		try {
			result = await verifyFcrdns(ip, [expected], deps);
		} catch (err) {
			// Defensive: verifyFcrdns shouldn't throw, but never let one IP abort startup.
			result = { ip, ok: false, ptrNames: [], expectedNames: [normalizeName(expected)], reason: 'lookup-error' };
			logger.warn({ ip, err }, 'FCrDNS self-check threw unexpectedly');
		}

		if (!result.ok) {
			logger.warn(
				{
					ip: result.ip,
					reason: result.reason,
					ptrNames: result.ptrNames,
					expectedEhlo: result.expectedNames,
				},
				`FCrDNS self-check FAILED for sending IP ${result.ip} (${result.reason}) — receiving MTAs (Gmail/Yahoo) may reject or spam-folder mail from this IP; ensure its PTR record matches its EHLO name`,
			);
		}
		results.push(result);
	}

	const okCount = results.filter((r) => r.ok).length;
	logger.info({ total: results.length, ok: okCount }, 'FCrDNS self-check complete');

	return results;
}
