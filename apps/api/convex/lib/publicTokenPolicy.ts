/**
 * Public token policy — how an anonymous request that presents a capability
 * token (a share, archive, unsubscribe, preference, DOI, booking, form or
 * attachment-share link) spends rate limits.
 *
 * Two kinds of state, never mixed:
 *
 *   - A CAPABILITY bucket, `<network>:<sha256(token)>`, charged by `admitCapability`
 *     only once the caller has verified that the token is real. Invented tokens
 *     never get one, a valid token is charged on the same key whatever else is
 *     going on, and the stored key never holds the token itself.
 *   - FAILURE buckets, charged by `chargeTokenFailure` for every request that is
 *     not admitted (missing, malformed or unknown token, a bad body, a handler
 *     that threw before admitting). Their keys come from a fixed set: one of
 *     4,096 shards of the client's network, plus one global key. However many
 *     tokens a caller invents, the rows they can touch stay bounded, and a valid
 *     link never reads them.
 *
 * A client's NETWORK is its address, except that IPv6 counts by /64 (one host
 * usually holds a whole /64 and can use any address in it) and IPv4-mapped
 * IPv6 counts as its IPv4, so neither can spread over shards or buckets.
 *
 * The token is decoded exactly once (`canonicalizeToken`); the decoded value is
 * what the handler sees and what the capability key is derived from, so every
 * spelling of one token (`%73` vs `s`, path vs `?token=`) is the same token.
 */

import { internal } from '../_generated/api';
import { sha256Hex } from './aiRouting/routeDigest';
import { safeDecodeURIComponent } from './inputGuards';
import { expandIpv6 } from './ipBlocklist';
import type { PublicRateLimitType } from './publicRateLimit';

/** The shared key `getClientIp` answers when no client address resolves. */
export const UNRESOLVED_CLIENT_KEY = 'unknown';

/**
 * Longest decoded token accepted. Every token the app issues is far shorter;
 * the cap keeps arbitrary request text out of hashing and lookups.
 */
export const MAX_TOKEN_LENGTH = 512;

/** Hex digits of the address digest that pick a failure shard (16³ = 4,096). */
const FAILURE_SHARD_HEX_DIGITS = 3;

/** Enough of the action ctx to run the limiter mutations. */
export interface MutationRunner {
	runMutation: <T>(mutation: unknown, args: unknown) => Promise<T>;
}

export interface LimitOutcome {
	ok: boolean;
	retryAfter: number;
}

/**
 * Decode the extracted token once and check it. The result is both the
 * handler's token and the rate-limit identity.
 */
export function canonicalizeToken(
	tokenRaw: string | null
): { ok: true; token: string } | { ok: false; message: string } {
	if (!tokenRaw) return { ok: false, message: 'Missing token' };
	const token = safeDecodeURIComponent(tokenRaw);
	if (token === null) return { ok: false, message: 'Invalid token encoding' };
	if (token.length > MAX_TOKEN_LENGTH) return { ok: false, message: 'Token too long' };
	return { ok: true, token };
}

/**
 * The network a client address stands for in rate-limit keys: an IPv6 address
 * by its /64, an IPv4-mapped IPv6 address by its IPv4, anything else as given.
 */
export function clientNetwork(ip: string): string {
	if (!ip.includes(':')) return ip;
	const hextets = expandIpv6(ip.replace(/^\[(.*)\]$/, '$1').toLowerCase());
	if (!hextets) return ip;
	if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
		const hi = hextets[6]!;
		const lo = hextets[7]!;
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	return `${hextets
		.slice(0, 4)
		.map((h) => h.toString(16))
		.join(':')}::/64`;
}

/** The capability bucket key for a verified token, scoped by client network. */
export function capabilityKey(scope: string, token: string): string {
	return `${scope}:${sha256Hex(token)}`;
}

/**
 * The failure shard for a client's network, or `null` for the shared unresolved
 * key, which only spends the global failure budget.
 */
export function failureShardKey(ip: string): string | null {
	if (ip === UNRESOLVED_CLIENT_KEY) return null;
	return `ip:${sha256Hex(clientNetwork(ip)).slice(0, FAILURE_SHARD_HEX_DIGITS)}`;
}

/**
 * Charge a verified token's own bucket. Call it only after the token resolved
 * to a real capability, and before anything the request changes.
 */
export function admitCapability(
	ctx: MutationRunner,
	args: { limitType: PublicRateLimitType; ip: string; token: string }
): Promise<LimitOutcome> {
	return ctx.runMutation<LimitOutcome>(internal.lib.publicRateLimit.checkPublicRateLimit, {
		limitType: args.limitType,
		key: capabilityKey(clientNetwork(args.ip), args.token),
	});
}

/** Spend one failure from the caller's shard and the global failure budget. */
export function chargeTokenFailure(ctx: MutationRunner, ip: string): Promise<LimitOutcome> {
	return ctx.runMutation<LimitOutcome>(internal.lib.publicRateLimit.chargePublicTokenFailure, {
		shardKey: failureShardKey(ip),
	});
}
