/**
 * Authentication rate limiter for the IMAP LOGIN path.
 *
 * Two sliding-window counters (sorted-set under Redis), co-located in one
 * Redis slot by the `{<ip>}` hash tag so a single script may touch both:
 *   - `imap:lim:{<ip>}:ip` — bound on global noise from one IP.
 *   - `imap:lim:{<ip>}:auth:<sha256(addr)>` — bound on per-credential
 *     brute-force: an IP working through many mailboxes stays under the global
 *     cap while each individual credential still gets only `failuresPerWindow`
 *     guesses per window.
 *
 * When either window is over budget the caller sleeps for at most
 * `tarpitMs` (capped at 5 s by the caller to keep file descriptors free)
 * before returning the credential-failed response. Redis remembers the
 * full window so the next reconnect from the same address-IP tuple is
 * still throttled.
 *
 * ## Why the address is hashed, and why minting is capped
 *
 * Both halves of the per-credential key come from an unauthenticated peer on
 * an internet-facing port, so both were attacker-controlled. The address went
 * in verbatim, and a pre-auth LOGIN line may be up to `maxLineBytes` (64 KiB),
 * so one failed login could mint a ~64 KiB Redis key — and the Redis this
 * shares with the MTA now runs `--maxmemory` (512 MB by default) under
 * `maxmemory-policy noeviction`, where reaching the cap means Redis refuses
 * writes and the MTA stops accepting mail. About 8k failed logins inside the
 * 120 s key lifetime got there, which one host can produce.
 *
 * Hashing the address fixes the key at ~95 bytes however long the claimed
 * mailbox is, and `recordFailure` additionally refuses to mint a NEW
 * per-credential key for an IP already past its global budget — that IP is
 * throttled by the `ip` counter for the rest of the window either way, so
 * capping it costs no protection and bounds the key space at
 * `PER_IP_FAILURE_LIMIT` credentials per IP per window instead of leaving it
 * unbounded. Existing keys are still refreshed, so nobody who is mid-window
 * loses their own counter.
 *
 * Failure mode: Redis unreachable → fail-open (warn-log + skip), so a
 * misconfigured Redis cannot lock everyone out of their mail.
 */

import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { logger } from './logger.js';

export interface RateLimitConfig {
	/** Per-(ip,address) failure budget per windowMs. */
	failuresPerWindow: number;
	windowMs: number;
	/** Tarpit duration once over budget (caller may further cap). */
	tarpitMs: number;
}

const PER_IP_FAILURE_LIMIT = 50;

/**
 * Record one failed LOGIN against both windows, atomically.
 *
 * KEYS: 1 = per-IP counter, 2 = per-(IP, credential) counter.
 * ARGV: 1 = now (ms), 2 = window cutoff (ms), 3 = member, 4 = TTL (s),
 *       5 = per-IP failure limit.
 *
 * The `EXISTS or ZCARD` guard is the cardinality bound described above. It has
 * to be inside the script: computed client-side it would race two connections
 * into minting unbounded keys for the same over-budget IP.
 */
const RECORD_FAILURE_LUA = `
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local member = ARGV[3]
local ttlSeconds = tonumber(ARGV[4])
local perIpLimit = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
redis.call('ZADD', KEYS[1], now, member)
redis.call('EXPIRE', KEYS[1], ttlSeconds)

if redis.call('EXISTS', KEYS[2]) == 1 or redis.call('ZCARD', KEYS[1]) <= perIpLimit then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, cutoff)
  redis.call('ZADD', KEYS[2], now, member)
  redis.call('EXPIRE', KEYS[2], ttlSeconds)
  return 1
end
return 0
`;

export interface CheckResult {
	throttled: boolean;
	tarpitMs: number;
	ipCount: number;
	authCount: number;
}

export class AuthRateLimiter {
	constructor(
		private redis: Redis | null,
		private config: RateLimitConfig
	) {}

	private ipKey(ip: string): string {
		return `imap:lim:{${ip}}:ip`;
	}

	private authKey(ip: string, address: string): string {
		const digest = createHash('sha256').update(address.toLowerCase()).digest('hex');
		return `imap:lim:{${ip}}:auth:${digest}`;
	}

	/**
	 * Count current failures inside the window. Does NOT increment —
	 * callers run this before LOGIN to decide whether to tarpit, and
	 * separately call `recordFailure` on the failure branch.
	 */
	async check(ip: string, address: string): Promise<CheckResult> {
		if (!this.redis) {
			return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
		}
		const now = Date.now();
		const cutoff = now - this.config.windowMs;
		try {
			const pipeline = this.redis.pipeline();
			pipeline.zremrangebyscore(this.ipKey(ip), 0, cutoff);
			pipeline.zcard(this.ipKey(ip));
			pipeline.zremrangebyscore(this.authKey(ip, address), 0, cutoff);
			pipeline.zcard(this.authKey(ip, address));
			const results = await pipeline.exec();
			if (!results) {
				return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
			}
			const ipCount = (results[1]?.[1] as number) ?? 0;
			const authCount = (results[3]?.[1] as number) ?? 0;
			const throttled =
				authCount >= this.config.failuresPerWindow || ipCount >= PER_IP_FAILURE_LIMIT;
			return {
				throttled,
				tarpitMs: throttled ? this.config.tarpitMs : 0,
				ipCount,
				authCount,
			};
		} catch (err) {
			logger.warn({ err, ip }, 'auth rate-limit check failed — failing open');
			return { throttled: false, tarpitMs: 0, ipCount: 0, authCount: 0 };
		}
	}

	/**
	 * Record a failed LOGIN. Called AFTER the credential check fails so
	 * a successful login doesn't accidentally accrue a failure.
	 */
	async recordFailure(ip: string, address: string): Promise<void> {
		if (!this.redis) return;
		const now = Date.now();
		// Set TTL slightly longer than the window so stale entries get GC'd
		// even if `check` doesn't run for that key for a while.
		const ttlSec = Math.ceil(this.config.windowMs / 1000) + 60;
		try {
			// Use `now + random` member names so concurrent failures don't
			// collide on the same score+member pair (zset dedupes).
			const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
			await this.redis.eval(
				RECORD_FAILURE_LUA,
				2,
				this.ipKey(ip),
				this.authKey(ip, address),
				String(now),
				String(now - this.config.windowMs),
				member,
				String(ttlSec),
				String(PER_IP_FAILURE_LIMIT)
			);
		} catch (err) {
			logger.warn({ err, ip }, 'auth rate-limit record failed — failing open');
		}
	}
}
