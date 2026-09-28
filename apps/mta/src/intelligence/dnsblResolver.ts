/**
 * The DNS transport for blocklist lookups.
 *
 * Spamhaus refuses queries it cannot attribute: anything relayed by a shared
 * resolver (the hosting provider's, 1.1.1.1, 8.8.8.8) gets the reserved
 * 127.255.255.254 answer instead of data, which `dnsblLookup.ts` reads as
 * `unknown` — and an unknown never clears a quarantine. The shipped compose
 * files therefore run a small recursive resolver (`dns-resolver`, Unbound) next
 * to the MTA, and `DNSBL_RESOLVER` points blocklist lookups at it so they leave
 * from this server's own address rather than a shared one.
 *
 * Only blocklist lookups use it. MX discovery and everything else keeps the
 * system resolver, so a resolver problem here can never stop delivery.
 *
 * When the bundled resolver cannot answer at all (container missing, no
 * outbound port 53 to the root servers) the lookup falls back to the system
 * resolver. The fallback cannot produce a false `clean`: whatever the system
 * resolver says goes through the same three-state reading as before.
 */

import { lookup, resolve4 as systemResolve4, Resolver } from 'dns/promises';
import { isIP } from 'node:net';

export interface DnsblResolverTarget {
	host: string;
	port: number;
}

/** Which resolver answered the most recent lookup. */
export type DnsblResolverPath = 'bundled' | 'system';

export interface DnsblTransport {
	resolve4: (hostname: string) => Promise<string[]>;
	/** `bundled` when a resolver is configured, whether or not it last answered. */
	configured: DnsblResolverPath;
	/** The resolver that produced the last answer (or the last failure). */
	lastPath: () => DnsblResolverPath;
}

/** A per-attempt ceiling that leaves the caller's 5 s budget room for the fallback. */
const BUNDLED_TIMEOUT_MS = 2_000;
/** Re-resolve the resolver's container address this often; compose may move it. */
const ADDRESS_TTL_MS = 5 * 60 * 1000;
/** Resolver answers, not transport failures: they are never retried elsewhere. */
const ANSWER_CODES = new Set(['ENOTFOUND', 'ENODATA']);

/**
 * Parse `DNSBL_RESOLVER`: `host`, `host:port`, an IPv4 address, or a bracketed
 * IPv6 address with an optional port. Empty means "use the system resolver".
 */
export function parseDnsblResolver(value: string | undefined): DnsblResolverTarget | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const bracketed = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(raw);
	const plain = /^([a-zA-Z0-9.-]+)(?::(\d+))?$/.exec(raw);
	const match = bracketed ?? plain;
	const host = match?.[1];
	if (!host || (bracketed && isIP(host) !== 6)) {
		throw new Error('DNSBL_RESOLVER must be host, host:port, or [ipv6]:port');
	}
	const port = match[2] === undefined ? 53 : Number(match[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error('DNSBL_RESOLVER port must be between 1 and 65535');
	}
	return { host, port };
}

function isAnswer(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string' &&
		ANSWER_CODES.has(error.code)
	);
}

type AddressLookup = (host: string, options: { family?: 4 }) => Promise<{ address: string }>;

/**
 * The resolver's address, IPv4 first. The bundled Unbound listens on 0.0.0.0
 * only (docker/unbound.conf), but with MTA_IPV6_ENABLED the compose network has
 * an IPv6 subnet too, and a lookup in OS order can return the container's AAAA
 * record first: every bundled query would then time out and fall back. A
 * resolver named by an IPv6-only hostname still resolves through the second try.
 */
export async function lookupResolverAddress(
	host: string,
	lookupFn: AddressLookup = (name, options) => lookup(name, options)
): Promise<string> {
	if (isIP(host)) return host;
	try {
		return (await lookupFn(host, { family: 4 })).address;
	} catch {
		return (await lookupFn(host, {})).address;
	}
}

export interface DnsblTransportDeps {
	lookupAddress?: (host: string) => Promise<string>;
	createResolver?: (server: string) => { resolve4: (hostname: string) => Promise<string[]> };
	systemResolve4?: (hostname: string) => Promise<string[]>;
	now?: () => number;
}

const defaultTransportDeps: Required<DnsblTransportDeps> = {
	lookupAddress: (host) => lookupResolverAddress(host),
	createResolver: (server) => {
		const resolver = new Resolver({ timeout: BUNDLED_TIMEOUT_MS, tries: 1 });
		resolver.setServers([server]);
		return resolver;
	},
	systemResolve4,
	now: Date.now,
};

function formatServer(address: string, port: number): string {
	return isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/** Build the blocklist transport. Without a target it is the system resolver. */
export function createDnsblTransport(
	target: DnsblResolverTarget | undefined,
	overrides: DnsblTransportDeps = {}
): DnsblTransport {
	const deps = { ...defaultTransportDeps, ...overrides };
	let last: DnsblResolverPath = target ? 'bundled' : 'system';
	if (!target) {
		return {
			resolve4: (hostname) => deps.systemResolve4(hostname),
			configured: 'system',
			lastPath: () => last,
		};
	}

	let cached: { resolver: ReturnType<typeof deps.createResolver>; expiresAt: number } | null = null;
	const bundled = async () => {
		if (cached && cached.expiresAt > deps.now()) return cached.resolver;
		const address = await deps.lookupAddress(target.host);
		cached = {
			resolver: deps.createResolver(formatServer(address, target.port)),
			expiresAt: deps.now() + ADDRESS_TTL_MS,
		};
		return cached.resolver;
	};

	return {
		configured: 'bundled',
		lastPath: () => last,
		resolve4: async (hostname) => {
			// Finding the resolver and asking it are separate steps: ENOTFOUND for
			// the resolver's own name means the container is gone, while ENOTFOUND
			// from the resolver is an NXDOMAIN answer about the queried name.
			const resolver = await bundled().catch(() => null);
			if (resolver) {
				try {
					const answers = await resolver.resolve4(hostname);
					last = 'bundled';
					return answers;
				} catch (error) {
					if (isAnswer(error)) {
						last = 'bundled';
						throw error;
					}
					// The container address may have changed under a recreate.
					cached = null;
				}
			}
			last = 'system';
			return deps.systemResolve4(hostname);
		},
	};
}

let shared: { key: string; transport: DnsblTransport } | null = null;

/**
 * The process-wide blocklist transport for this configuration. One instance, so
 * the sweep, the IP audit and the admin route see the same `lastPath`.
 */
export function getDnsblTransport(config: { dnsblResolver?: DnsblResolverTarget }): DnsblTransport {
	const target = config.dnsblResolver;
	const key = target ? `${target.host}:${target.port}` : '';
	if (shared?.key !== key) shared = { key, transport: createDnsblTransport(target) };
	return shared.transport;
}
