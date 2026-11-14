/**
 * The addresses an outbound SMTP session may connect to for one MX host.
 *
 * The MTA resolves A and AAAA itself and connects to an address literal; it
 * never hands the MX hostname to `net.connect`. Two reasons:
 *
 * - Family. With a bound `localAddress` Node does a single OS-ordered lookup
 *   and fails with `bind EINVAL` when the first answer has the other family.
 *   Without one it may pick either family, so mail for an IPv4 pool IP could
 *   leave over IPv6 from a source whose PTR and SPF nobody checked. The caller
 *   picks the addresses of the family its source IP has.
 * - Reach. MX records are published by the recipient domain's owner, who can
 *   point them at loopback, a private range or link-local space. Every answer
 *   is screened with the same blocklist the MTA-STS policy fetch uses, and an
 *   address it refuses is never connected to. The check runs on the exact
 *   addresses the socket dials, so a name that rebinds between two lookups
 *   cannot slip through. `allowPrivate` (`MTA_ALLOW_PRIVATE_MX`) turns the
 *   screen off for a lab or a test fixture that delivers to a local catcher.
 *
 * The lookups go to DNS (`resolve4`/`resolve6`), not `getaddrinfo`, so an
 * authoritative "no such name" or "no record" can be told from SERVFAIL or a
 * timeout. `/etc/hosts` is therefore not consulted, except that `localhost`
 * names are answered as loopback (RFC 6761 §6.3) so they are screened too.
 */

import { isIP } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { errorMessage } from '@owlat/shared';
import type { IpAddressFamily } from '@owlat/shared/ipAddress';
import { isDisallowedIpAddress } from '@owlat/shared/ipBlocklist';
import type { MxResolution } from './mxResolver.js';

export type MxHostAddresses =
	/** At least one connectable address, by family, in DNS order. */
	| { status: 'resolved'; ipv4: string[]; ipv6: string[] }
	/** The host resolved, but only to addresses the screen refuses. */
	| { status: 'refused'; addresses: string[] }
	/** Authoritatively no A and no AAAA record (NXDOMAIN or NODATA for both). */
	| { status: 'not-found' }
	/** No connectable address and at least one lookup failed (SERVFAIL, timeout). */
	| { status: 'temporary-failure'; reason: string };

interface RecordWithTtl {
	address: string;
	ttl: number;
}

export interface AddressLookups {
	resolve4(host: string): Promise<RecordWithTtl[]>;
	resolve6(host: string): Promise<RecordWithTtl[]>;
}

type FamilyAnswer =
	| { kind: 'addresses'; addresses: string[]; ttl: number }
	| { kind: 'none' }
	| { kind: 'failed'; reason: string };

interface HostAnswer {
	ipv4: FamilyAnswer;
	ipv6: FamilyAnswer;
}

/** DNS answers are cached for their TTL, but never longer than this. */
const MAX_CACHE_SECONDS = 300;
/** An authoritative "no address" is cached this long (RFC 2308 negative caching, capped). */
const NEGATIVE_CACHE_SECONDS = 60;
const MAX_CACHE_ENTRIES = 10_000;

function errorCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
	return typeof error.code === 'string' ? error.code.toUpperCase() : undefined;
}

async function lookupFamily(
	lookup: (host: string) => Promise<RecordWithTtl[]>,
	host: string
): Promise<FamilyAnswer> {
	try {
		const records = await lookup(host);
		if (records.length === 0) return { kind: 'none' };
		return {
			kind: 'addresses',
			addresses: records.map((record) => record.address),
			ttl: Math.min(...records.map((record) => record.ttl)),
		};
	} catch (err) {
		const code = errorCode(err);
		// c-ares reports NXDOMAIN as ENOTFOUND and an empty NOERROR answer as
		// ENODATA. Both are authoritative; everything else may change on retry.
		if (code === 'ENOTFOUND' || code === 'ENODATA') return { kind: 'none' };
		return { kind: 'failed', reason: `${code ?? 'error'}: ${errorMessage(err)}` };
	}
}

function literalAnswer(host: string): HostAnswer | null {
	const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
	const version = isIP(bare);
	const none: FamilyAnswer = { kind: 'none' };
	const only = (address: string): FamilyAnswer => ({
		kind: 'addresses',
		addresses: [address],
		ttl: MAX_CACHE_SECONDS,
	});
	if (version === 4) return { ipv4: only(bare), ipv6: none };
	if (version === 6) return { ipv4: none, ipv6: only(bare) };
	if (host === 'localhost' || host.endsWith('.localhost')) {
		return { ipv4: only('127.0.0.1'), ipv6: only('::1') };
	}
	return null;
}

/** Sort one host's answers into connectable and refused addresses. */
export function screenHostAnswer(answer: HostAnswer, allowPrivate: boolean): MxHostAddresses {
	const usable = (family: FamilyAnswer): string[] =>
		family.kind === 'addresses'
			? family.addresses.filter((address) => allowPrivate || !isDisallowedIpAddress(address))
			: [];
	const ipv4 = usable(answer.ipv4);
	const ipv6 = usable(answer.ipv6);
	if (ipv4.length > 0 || ipv6.length > 0) return { status: 'resolved', ipv4, ipv6 };

	const failures = [answer.ipv4, answer.ipv6].flatMap((family) =>
		family.kind === 'failed' ? [family.reason] : []
	);
	if (failures.length > 0) return { status: 'temporary-failure', reason: failures.join('; ') };

	const refused = [answer.ipv4, answer.ipv6].flatMap((family) =>
		family.kind === 'addresses' ? family.addresses : []
	);
	return refused.length > 0 ? { status: 'refused', addresses: refused } : { status: 'not-found' };
}

function cacheSeconds(answer: HostAnswer): number | null {
	const families = [answer.ipv4, answer.ipv6];
	if (families.some((family) => family.kind === 'failed')) return null;
	const ttls = families.flatMap((family) => (family.kind === 'addresses' ? [family.ttl] : []));
	const seconds = ttls.length > 0 ? Math.min(...ttls, MAX_CACHE_SECONDS) : NEGATIVE_CACHE_SECONDS;
	return seconds > 0 ? seconds : null;
}

export interface MxAddressResolver {
	resolve(host: string, options: { allowPrivate: boolean }): Promise<MxHostAddresses>;
}

/** A resolver with its own answer cache. Production uses {@link resolveMxHostAddresses}. */
export function createMxAddressResolver(
	lookups: AddressLookups,
	now: () => number = Date.now
): MxAddressResolver {
	const cache = new Map<string, { expiresAt: number; answer: HostAnswer }>();

	async function answerFor(host: string): Promise<HostAnswer> {
		const literal = literalAnswer(host);
		if (literal) return literal;
		const cached = cache.get(host);
		if (cached && cached.expiresAt > now()) return cached.answer;
		cache.delete(host);

		const [ipv4, ipv6] = await Promise.all([
			lookupFamily((name) => lookups.resolve4(name), host),
			lookupFamily((name) => lookups.resolve6(name), host),
		]);
		const answer = { ipv4, ipv6 };
		const seconds = cacheSeconds(answer);
		if (seconds !== null) {
			if (cache.size >= MAX_CACHE_ENTRIES) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(host, { expiresAt: now() + seconds * 1000, answer });
		}
		return answer;
	}

	return {
		async resolve(host, { allowPrivate }) {
			const normalized = host.trim().toLowerCase().replace(/\.$/, '');
			return screenHostAnswer(await answerFor(normalized), allowPrivate);
		},
	};
}

const dnsResolver = new Resolver();
const defaultResolver = createMxAddressResolver({
	resolve4: (host) => dnsResolver.resolve4(host, { ttl: true }),
	resolve6: (host) => dnsResolver.resolve6(host, { ttl: true }),
});

/** Resolve and screen one MX host's addresses through the process-wide cache. */
export function resolveMxHostAddresses(
	host: string,
	options: { allowPrivate: boolean }
): Promise<MxHostAddresses> {
	return defaultResolver.resolve(host, options);
}

/** The family an outbound socket for `sourceIp` must connect over. */
export function connectFamilyFor(sourceIp: string): IpAddressFamily {
	return isIP(sourceIp) === 6 ? 'ipv6' : 'ipv4';
}

/**
 * The address families at least one of `hosts` can be reached over, or `null`
 * when no host resolved to a connectable address (nothing to prefer then).
 * Source-IP selection reads it to avoid picking an IP of a family the
 * destination has no address for.
 */
export async function reachableFamilies(
	hosts: readonly string[],
	options: { allowPrivate: boolean },
	resolve: (
		host: string,
		options: { allowPrivate: boolean }
	) => Promise<MxHostAddresses> = resolveMxHostAddresses
): Promise<ReadonlySet<IpAddressFamily> | null> {
	const families = new Set<IpAddressFamily>();
	for (const resolution of await Promise.all(hosts.map((host) => resolve(host, options)))) {
		if (resolution.status !== 'resolved') continue;
		if (resolution.ipv4.length > 0) families.add('ipv4');
		if (resolution.ipv6.length > 0) families.add('ipv6');
	}
	return families.size > 0 ? families : null;
}

/**
 * {@link reachableFamilies} for a resolved destination, deferred until source-IP
 * selection actually has two families to choose between. `undefined` when the
 * destination has no MX hosts to look at.
 */
export function reachableFamiliesOf(
	mx: MxResolution,
	options: { allowPrivate: boolean }
): (() => Promise<ReadonlySet<IpAddressFamily> | null>) | undefined {
	if (mx.status !== 'deliverable') return undefined;
	const hosts = mx.hosts.map((host) => host.exchange);
	return () => reachableFamilies(hosts, options);
}
