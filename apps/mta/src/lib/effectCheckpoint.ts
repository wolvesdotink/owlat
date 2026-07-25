/** Durable checkpoints for replaying side effects after an owned operation. */

import { createHash, randomUUID } from 'crypto';
import type Redis from 'ioredis';

/** Shared lease-state transitions; storage/parent ownership remain adapter-specific. */
export const EFFECT_LEASE_LUA_FUNCTIONS = `
local function parsePendingEffectLease(state)
  local _, _, token, expiresAt = string.find(state or '', '^pending:([^:]+):([%d%.]+)$')
  return token, tonumber(expiresAt)
end
local function inspectEffectLease(state, token, now)
  if state == 'applied' then return 0, nil end
  local pendingToken, expiresAt = parsePendingEffectLease(state)
  if pendingToken and expiresAt and expiresAt > 0 and expiresAt > now then
    if pendingToken == token then return 1, expiresAt end
    return 2, expiresAt
  end
  return 3, nil
end
local function ownsCurrentEffectLease(state, token, now)
  local pendingToken, expiresAt = parsePendingEffectLease(state)
  return pendingToken == token and expiresAt and expiresAt > 0 and expiresAt > now
end
local function ownsEffectLeaseToken(state, token)
  local pendingToken, _ = parsePendingEffectLease(state)
  return pendingToken == token
end
local function pendingEffectLease(token, now, leaseMs)
  local expiresAt = now + leaseMs
  return 'pending:' .. token .. ':' .. expiresAt, expiresAt
end
`;

const BEGIN_EFFECT_LUA = `${EFFECT_LEASE_LUA_FUNCTIONS}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local state = redis.call('HGET', KEYS[2], ARGV[2])
local disposition, currentExpiry = inspectEffectLease(state, ARGV[5], tonumber(ARGV[4]))
if disposition == 0 then return {0, ''} end
if disposition == 1 then return {1, tostring(currentExpiry)} end
if disposition == 2 then return {2, tostring(currentExpiry)} end
local pendingState, expiresAt = pendingEffectLease(ARGV[5], tonumber(ARGV[4]), tonumber(ARGV[6]))
redis.call('HSET', KEYS[2], ARGV[2], pendingState)
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return {1, tostring(expiresAt)}
`;

const RENEW_EFFECT_LUA = `${EFFECT_LEASE_LUA_FUNCTIONS}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local state = redis.call('HGET', KEYS[2], ARGV[2])
if not ownsCurrentEffectLease(state, ARGV[4], tonumber(ARGV[5])) then return -1 end
local pendingState, expiresAt = pendingEffectLease(ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]))
redis.call('HSET', KEYS[2], ARGV[2], pendingState)
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return expiresAt
`;

const COMPLETE_EFFECT_LUA = `${EFFECT_LEASE_LUA_FUNCTIONS}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local state = redis.call('HGET', KEYS[2], ARGV[2])
if not ownsCurrentEffectLease(state, ARGV[4], tonumber(ARGV[5])) then return -1 end
redis.call('HSET', KEYS[2], ARGV[2], 'applied')
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const RELEASE_EFFECT_LUA = `${EFFECT_LEASE_LUA_FUNCTIONS}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
local state = redis.call('HGET', KEYS[2], ARGV[2])
if not ownsEffectLeaseToken(state, ARGV[4]) then return -1 end
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return 1
`;

const DEFAULT_EFFECT_LEASE_MS = 60_000;
const DEFAULT_EFFECT_WAIT_MS = 50;
/** Longest parent replay horizon (FBL complaint deduplication: seven days). */
export const DURABLE_EFFECT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EffectCheckpointScope {
	/** Redis string whose exact value proves that this processor still owns the operation. */
	readonly ownerKey: string;
	readonly ownerValue: string;
	readonly checkpointsKey: string;
	/** Stable parent identity used to derive downstream idempotency keys. */
	readonly downstreamScope: string;
	readonly ttlMs: number;
	readonly leaseMs?: number;
	readonly waitMs?: number;
}

export class EffectCheckpointError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, { cause });
		this.name = 'EffectCheckpointError';
	}
}

export type EffectLeaseStart =
	| { readonly kind: 'applied' }
	| { readonly kind: 'acquired' }
	| { readonly kind: 'busy'; readonly expiresAt: number };

export interface EffectLeaseStore {
	begin(token: string, now: number, leaseMs: number): Promise<EffectLeaseStart>;
	renew(token: string, now: number, leaseMs: number): Promise<void>;
	complete(token: string, now: number): Promise<void>;
	release(token: string): Promise<void>;
}

export interface EffectLeaseOptions {
	readonly leaseMs?: number;
	readonly waitMs?: number;
}

declare const durableEffectIdentityBrand: unique symbol;
export type DurableEffectIdentity = string & { readonly [durableEffectIdentityBrand]: true };

export function durableEffectIdentity(
	downstreamScope: string,
	effectIdentity: string
): DurableEffectIdentity {
	return `effect:v1:${createHash('sha256')
		.update(downstreamScope)
		.update('\0')
		.update(effectIdentity)
		.digest('hex')}` as DurableEffectIdentity;
}

/**
 * Run one effect unless a prior execution durably completed it.
 *
 * `pending` is token-owned and leased: contenders wait while its owner
 * heartbeats, but a crash or lost begin response becomes retryable after lease
 * expiry. The transition to `applied` happens only after the effect resolves.
 * An external effect can still run twice if the process dies after that effect
 * commits but before Redis records `applied`; callers should pass deterministic
 * identities through to downstream APIs whenever those APIs support idempotency.
 */
export async function runCheckpointedEffect<T>(
	redis: Redis,
	scope: EffectCheckpointScope,
	effectIdentity: string,
	apply: (downstreamIdentity: DurableEffectIdentity) => Promise<T>
): Promise<T | undefined> {
	const downstreamIdentity = durableEffectIdentity(scope.downstreamScope, effectIdentity);
	return runLeasedEffect(
		{
			begin: async (token, now, leaseMs) => {
				let started: [number, string];
				try {
					started = (await redis.eval(
						BEGIN_EFFECT_LUA,
						2,
						scope.ownerKey,
						scope.checkpointsKey,
						scope.ownerValue,
						effectIdentity,
						String(scope.ttlMs),
						String(now),
						token,
						String(leaseMs)
					)) as [number, string];
				} catch (error) {
					throw new EffectCheckpointError('Effect checkpoint could not be started', error);
				}
				if (started[0] < 0) throw new EffectCheckpointError('Effect checkpoint owner changed');
				if (started[0] === 0) return { kind: 'applied' };
				if (started[0] === 1) return { kind: 'acquired' };
				return busyLease(Number(started[1]));
			},
			renew: async (token, now, leaseMs) => {
				try {
					const renewed = (await redis.eval(
						RENEW_EFFECT_LUA,
						2,
						scope.ownerKey,
						scope.checkpointsKey,
						scope.ownerValue,
						effectIdentity,
						String(scope.ttlMs),
						token,
						String(now),
						String(leaseMs)
					)) as number;
					if (renewed < 0) throw new Error('lease owner changed');
				} catch (error) {
					throw new EffectCheckpointError('Effect checkpoint lease renewal failed', error);
				}
			},
			complete: async (token, now) => {
				try {
					const completed = (await redis.eval(
						COMPLETE_EFFECT_LUA,
						2,
						scope.ownerKey,
						scope.checkpointsKey,
						scope.ownerValue,
						effectIdentity,
						String(scope.ttlMs),
						token,
						String(now)
					)) as number;
					if (completed < 0) throw new Error('lease owner changed');
				} catch (error) {
					throw new EffectCheckpointError('Effect checkpoint could not be completed', error);
				}
			},
			release: async (token) => {
				try {
					const released = (await redis.eval(
						RELEASE_EFFECT_LUA,
						2,
						scope.ownerKey,
						scope.checkpointsKey,
						scope.ownerValue,
						effectIdentity,
						String(scope.ttlMs),
						token
					)) as number;
					if (released < 0) throw new Error('lease owner changed');
				} catch (error) {
					throw new EffectCheckpointError('Effect checkpoint could not be released', error);
				}
			},
		},
		() => apply(downstreamIdentity),
		{ leaseMs: scope.leaseMs, waitMs: scope.waitMs }
	);
}

/** Coordinate one active effect owner while retaining crash-expiry recovery. */
export async function runLeasedEffect<T>(
	store: EffectLeaseStore,
	apply: () => Promise<T>,
	options: EffectLeaseOptions = {}
): Promise<T | undefined> {
	const token = randomUUID();
	const leaseMs = options.leaseMs ?? DEFAULT_EFFECT_LEASE_MS;
	const waitMs = options.waitMs ?? DEFAULT_EFFECT_WAIT_MS;
	if (!Number.isFinite(leaseMs) || leaseMs <= 0 || !Number.isFinite(waitMs) || waitMs <= 0) {
		throw new EffectCheckpointError('Effect checkpoint timing must be finite and positive');
	}
	for (;;) {
		const started = await store.begin(token, Date.now(), leaseMs);
		if (started.kind === 'applied') return undefined;
		if (started.kind === 'acquired') break;
		await delay(Math.min(waitMs, Math.max(1, started.expiresAt - Date.now())));
	}

	let renewal = Promise.resolve();
	const heartbeat = setInterval(
		() => {
			// A transient renewal failure is not sticky: later heartbeats keep
			// trying, and the terminal transition validates the lease that exists
			// at that moment. This also tolerates a lost renewal response whose
			// Redis write committed.
			renewal = renewal.then(() => store.renew(token, Date.now(), leaseMs)).catch(() => {});
		},
		Math.max(5, Math.floor(leaseMs / 3))
	);
	let result: T;
	try {
		result = await apply();
	} catch (error) {
		clearInterval(heartbeat);
		await renewal;
		await store.release(token);
		throw error;
	}
	clearInterval(heartbeat);
	await renewal;
	await store.complete(token, Date.now());
	return result;
}

function busyLease(expiresAt: number): EffectLeaseStart {
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		throw new EffectCheckpointError('Effect checkpoint lease expiry is invalid');
	}
	return { kind: 'busy', expiresAt };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
