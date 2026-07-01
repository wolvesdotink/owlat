/**
 * Reverse-DNS (PTR) preflight for the deployment's receiving/EHLO mail host.
 *
 * Receiving MTAs (notably Gmail/Yahoo under their 2024 bulk-sender rules) reject
 * or spam-folder mail from a host whose IP has no PTR record, or whose PTR does
 * not forward-confirm to the announced hostname (FCrDNS — RFC 1912 §2.1, RFC
 * 5321 §4.1.1.1). The Settings → Domains "Receiving" panel used to print static
 * "set reverse DNS (PTR)" advice; this helper turns it into a live check so the
 * operator sees the concrete verdict for their own host.
 *
 * `apps/mta/src/scaling/fcrdns.ts` is the prior art for the FCrDNS logic — this
 * is a deliberately small re-implementation (no cross-app import) shaped for the
 * setup panel: resolve the host → A record(s), reverse-resolve the IP(s) to PTR
 * name(s), and report whether any PTR exists and whether one matches the host.
 *
 * Pure + fail-soft: the live DNS calls are injected via {@link ReverseDnsDeps}
 * so the classification/match logic is unit-testable without real DNS, and every
 * lookup failure resolves to a structured "not confirmed" result — it NEVER
 * throws into the caller (the setup UI must not break on a DNS hiccup).
 */

/** Structured verdict for the reverse-DNS preflight. Always resolvable — no throw. */
export type ReverseDnsResult = {
	/** True when the host's IP(s) resolve to at least one PTR name. */
	hasPtr: boolean;
	/** The first PTR name found (normalized), when any. */
	ptrValue?: string;
	/**
	 * True when a PTR name equals the checked host — forward-confirmed reverse
	 * DNS, the thing receiving MTAs require. False when there is no PTR or it
	 * points elsewhere.
	 */
	matchesHost: boolean;
	/** The mail host the check ran against (normalized), echoed for the UI copy. */
	checkedHost: string;
};

/**
 * Injectable DNS dependencies so the logic is testable without real DNS.
 * Mirrors the small surface `apps/mta/src/scaling/fcrdns.ts` uses.
 */
export type ReverseDnsDeps = {
	/** Forward-resolve a hostname to its IPv4 A records. */
	resolve4: (hostname: string) => Promise<string[]>;
	/** Reverse-resolve an IP to its PTR hostname(s). */
	reverse: (ip: string) => Promise<string[]>;
};

/** PTR names carry a trailing dot and vary in case — normalize for comparison. */
export function normalizeHost(name: string): string {
	return name.trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Check reverse DNS for `host`: resolve it to its IP(s), reverse-resolve each IP
 * to its PTR name(s), and report whether a PTR exists and whether one matches
 * the host (FCrDNS). Fail-soft — any lookup error is swallowed and folded into
 * the returned verdict; this function never rejects.
 */
export async function checkReverseDns(host: string, deps: ReverseDnsDeps): Promise<ReverseDnsResult> {
	const checkedHost = normalizeHost(host);
	const base: ReverseDnsResult = { hasPtr: false, matchesHost: false, checkedHost };
	if (!checkedHost) return base;

	let ips: string[];
	try {
		ips = await deps.resolve4(checkedHost);
	} catch {
		// Host has no A record / lookup failed — can't reverse-check. Fail soft.
		return base;
	}
	if (ips.length === 0) return base;

	const ptrNames: string[] = [];
	for (const ip of ips) {
		try {
			const names = await deps.reverse(ip);
			for (const name of names) {
				const normalized = normalizeHost(name);
				if (normalized) ptrNames.push(normalized);
			}
		} catch {
			// ENOTFOUND/ENODATA = no PTR for this IP; other codes = transient.
			// Either way, treat this IP as contributing no PTR and keep going.
		}
	}

	if (ptrNames.length === 0) return base;

	return {
		hasPtr: true,
		ptrValue: ptrNames[0],
		matchesHost: ptrNames.includes(checkedHost),
		checkedHost,
	};
}
