/**
 * `SCRIPT LOAD` / `EVALSHA` for ioredis-mock, which supports `EVAL` but not the
 * script cache around it.
 *
 * Real Redis keeps loaded script bodies in memory only, so a restart empties
 * the cache and every `EVALSHA` for a known SHA starts answering `NOSCRIPT`.
 * That is the failure mode the MTA has to survive, and it is only reachable in
 * a test if the double models the cache as separate, losable state — hence
 * `restart()`.
 */

import { createHash } from 'crypto';

interface EvalCapableRedis {
	eval: (...args: unknown[]) => Promise<unknown>;
}

export interface ScriptedRedisMock {
	/** Empty the script cache, as a Redis restart or `SCRIPT FLUSH` does. */
	restart: () => void;
	/** How many bodies have been loaded, including re-loads. */
	loads: () => number;
}

/** Give an ioredis-mock instance a losable server-side script cache. */
export function withLuaScripting(redis: object): ScriptedRedisMock {
	const loaded = new Map<string, string>();
	let loads = 0;
	const evaluate = (redis as EvalCapableRedis).eval.bind(redis);
	const patched = redis as unknown as Record<string, unknown>;

	patched['script'] = async (subcommand: string, source: string): Promise<unknown> => {
		if (String(subcommand).toLowerCase() !== 'load') return 'OK';
		loads += 1;
		const sha = createHash('sha1').update(source).digest('hex');
		loaded.set(sha, source);
		return sha;
	};

	patched['evalsha'] = async (sha: string, ...args: unknown[]): Promise<unknown> => {
		const source = loaded.get(sha);
		if (source === undefined) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
		return evaluate(source, ...args);
	};

	return {
		restart: () => loaded.clear(),
		loads: () => loads,
	};
}
