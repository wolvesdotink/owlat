/**
 * Survive a Redis restart that empties the server-side Lua script cache.
 *
 * Redis caches `SCRIPT LOAD`ed bodies in memory only: a restart, a failover to
 * a replica, or an explicit `SCRIPT FLUSH` empties that cache, and every
 * subsequent `EVALSHA` for a previously-loaded SHA fails with `NOSCRIPT`.
 * Clients are expected to re-load the body and retry — ioredis does exactly
 * that for scripts registered through `defineCommand`, but a caller that issues
 * `evalsha` directly gets no such recovery.
 *
 * GroupMQ is such a caller. It loads each Lua file once per client object and
 * memoises the SHA for the lifetime of that object
 * (`node_modules/groupmq/dist/index.js` `loadScript`), then only ever calls
 * `client.evalsha(...)`. Because the memo outlives the connection, one Redis
 * restart leaves every queue operation — enqueue, reserve, complete, retry,
 * promote — permanently failing with `NOSCRIPT` while the client cheerfully
 * reconnects. The worker cannot even record a failure, so nothing drains and
 * nothing dead-letters.
 *
 * This wraps the seam Owlat owns — the client it hands to GroupMQ — rather
 * than patching the dependency: remember the body behind every SHA this client
 * loads, and on `NOSCRIPT` re-load it and retry the call once. SHA1 is derived
 * from the body, so the reloaded script answers to the same SHA and the retry
 * is the original call verbatim.
 */

import type Redis from 'ioredis';
import { logger } from '../monitoring/logger.js';

/** Bodies this client has loaded, keyed by the SHA the server returned. */
interface ScriptCacheState {
	sources: Map<string, string>;
	reloads: Map<string, Promise<void>>;
}

const state = new WeakMap<object, ScriptCacheState>();

function isNoScriptError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('NOSCRIPT');
}

/**
 * Re-load one body, sharing a single round trip between concurrent callers.
 *
 * A restart fails every in-flight command at once, so the alternative is a
 * `SCRIPT LOAD` per queued command against a server that just came back.
 */
async function reloadScript(
	redis: Redis,
	cache: ScriptCacheState,
	sha: string,
	source: string
): Promise<void> {
	const inFlight = cache.reloads.get(sha);
	if (inFlight) return inFlight;

	const reload = (async () => {
		try {
			await redis.script('LOAD', source);
			logger.warn({ sha }, 'Redis script cache was empty — reloaded script after NOSCRIPT');
		} finally {
			cache.reloads.delete(sha);
		}
	})();
	cache.reloads.set(sha, reload);
	return reload;
}

/**
 * Make `evalsha` on this client self-heal after the server's script cache is
 * emptied. Returns the same client, patched in place; calling it twice is a
 * no-op, and `duplicate()` returns a patched client too, so every connection
 * this process derives keeps the guarantee.
 */
export function withScriptCacheRecovery(redis: Redis): Redis {
	if (state.has(redis)) return redis;
	const cache: ScriptCacheState = { sources: new Map(), reloads: new Map() };
	state.set(redis, cache);

	const script = redis.script.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	const evalsha = redis.evalsha.bind(redis) as (...args: unknown[]) => Promise<unknown>;
	const duplicate = redis.duplicate.bind(redis);

	const patched = redis as unknown as {
		script: (...args: unknown[]) => Promise<unknown>;
		evalsha: (...args: unknown[]) => Promise<unknown>;
		duplicate: (...args: Parameters<typeof duplicate>) => Redis;
	};

	patched.script = async (...args: unknown[]): Promise<unknown> => {
		const result = await script(...args);
		const [subcommand, source] = args;
		// Remember `SCRIPT LOAD <body>` → sha so a later NOSCRIPT is recoverable.
		if (
			typeof subcommand === 'string' &&
			subcommand.toLowerCase() === 'load' &&
			typeof source === 'string' &&
			typeof result === 'string'
		) {
			cache.sources.set(result, source);
		}
		return result;
	};

	patched.evalsha = async (...args: unknown[]): Promise<unknown> => {
		try {
			return await evalsha(...args);
		} catch (error) {
			const [sha] = args;
			if (!isNoScriptError(error) || typeof sha !== 'string') throw error;
			const source = cache.sources.get(sha);
			// A SHA this client never loaded is not ours to reconstruct; the
			// caller owns the body and must reload it itself.
			if (source === undefined) throw error;
			await reloadScript(redis, cache, sha, source);
			return await evalsha(...args);
		}
	};

	patched.duplicate = (...args: Parameters<typeof duplicate>): Redis =>
		withScriptCacheRecovery(duplicate(...args));

	return redis;
}
