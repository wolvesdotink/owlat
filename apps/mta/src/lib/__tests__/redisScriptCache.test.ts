/**
 * A Redis restart empties the server-side Lua script cache, and every client
 * holding a memoised SHA then fails `NOSCRIPT` until it re-loads the body.
 * GroupMQ memoises for the life of the client object and never re-loads, so
 * the recovery has to live on the client Owlat hands it.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { withScriptCacheRecovery } from '../redisScriptCache.js';

const NOSCRIPT = 'NOSCRIPT No matching script. Please use EVAL.';
const SOURCE = "return redis.call('GET', KEYS[1])";
const sha1 = (source: string) => createHash('sha1').update(source).digest('hex');

/**
 * A Redis whose script cache can be emptied under the client, as a restart
 * does. The patch replaces the client's own methods, so calls are counted on
 * the fake's state rather than on spies it would shadow.
 */
function createFakeRedis(loaded = new Set<string>()) {
	const calls = { load: 0, evalsha: [] as unknown[][] };
	let failNextWith: Error | null = null;

	const redis = {
		script: async (subcommand: string, source: string) => {
			if (subcommand.toLowerCase() !== 'load') return 'OK';
			calls.load++;
			const sha = sha1(source);
			loaded.add(sha);
			return sha;
		},
		evalsha: async (sha: string, ...rest: unknown[]) => {
			calls.evalsha.push([sha, ...rest]);
			if (failNextWith) {
				const error = failNextWith;
				failNextWith = null;
				throw error;
			}
			if (!loaded.has(sha)) throw new Error(NOSCRIPT);
			return 'result';
		},
		duplicate: () => createFakeRedis(loaded).redis,
	};

	return {
		redis: redis as unknown as Redis,
		calls,
		restart: () => loaded.clear(),
		failNext: (error: Error) => {
			failNextWith = error;
		},
	};
}

describe('redis script cache recovery', () => {
	it('reloads the body and retries when the server forgot the script', async () => {
		const fake = createFakeRedis();
		const redis = withScriptCacheRecovery(fake.redis);

		const sha = (await redis.script('load', SOURCE)) as string;
		expect(await redis.evalsha(sha, 1, 'key')).toBe('result');

		fake.restart();

		expect(await redis.evalsha(sha, 1, 'key')).toBe('result');
		expect(fake.calls.load).toBe(2);
		// Re-loading a body yields the same SHA, so the retry is the original
		// call verbatim rather than a rewritten one.
		expect(fake.calls.evalsha).toEqual([
			[sha, 1, 'key'],
			[sha, 1, 'key'],
			[sha, 1, 'key'],
		]);
	});

	it('shares one reload between the commands a restart fails together', async () => {
		const fake = createFakeRedis();
		const redis = withScriptCacheRecovery(fake.redis);
		const sha = (await redis.script('load', SOURCE)) as string;
		fake.restart();

		const results = await Promise.all([
			redis.evalsha(sha, 1, 'a'),
			redis.evalsha(sha, 1, 'b'),
			redis.evalsha(sha, 1, 'c'),
		]);

		expect(results).toEqual(['result', 'result', 'result']);
		expect(fake.calls.load).toBe(2); // the initial load plus one reload
	});

	it('leaves every other failure alone', async () => {
		const fake = createFakeRedis();
		const redis = withScriptCacheRecovery(fake.redis);
		const sha = (await redis.script('load', SOURCE)) as string;
		fake.failNext(new Error('WRONGTYPE Operation against a key'));

		await expect(redis.evalsha(sha, 1, 'key')).rejects.toThrow('WRONGTYPE');
		expect(fake.calls.load).toBe(1);
	});

	it('rethrows NOSCRIPT for a script this client never loaded', async () => {
		const redis = withScriptCacheRecovery(createFakeRedis().redis);

		await expect(redis.evalsha(sha1('someone elses script'), 0)).rejects.toThrow('NOSCRIPT');
	});

	it('carries the recovery into duplicated connections', async () => {
		const fake = createFakeRedis();
		const redis = withScriptCacheRecovery(fake.redis);

		const copy = redis.duplicate();
		const sha = (await copy.script('load', SOURCE)) as string;
		fake.restart(); // the duplicate talks to the same server

		expect(await copy.evalsha(sha, 1, 'key')).toBe('result');
	});

	it('patches a client once', () => {
		const redis = withScriptCacheRecovery(createFakeRedis().redis);
		const patched = redis.evalsha;

		expect(withScriptCacheRecovery(redis).evalsha).toBe(patched);
	});
});
