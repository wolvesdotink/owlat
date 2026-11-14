import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { checkDomainBlocklists } from '../domainBlocklist.js';
import { createRecordingLookupDeps, dnsError } from './dnsblFixtures.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const NOW = 1_800_000_000_000;

describe('domain blocklist lookups', () => {
	let redis: RealRedis;
	let answers: Record<string, string[]>;
	const answerFromTable = async (name: string) => {
		const answer = answers[name];
		if (!answer) throw dnsError('ENOTFOUND');
		return answer;
	};
	const resolve4 = vi.fn(answerFromTable);

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		answers = {};
		resolve4.mockReset();
		resolve4.mockImplementation(answerFromTable);
	});

	const check = (domains: string[], dqsKey?: string) =>
		checkDomainBlocklists(redis, domains, {
			lookup: { ...createRecordingLookupDeps().deps, resolve4 },
			...(dqsKey ? { dqsKey } : {}),
			now: () => NOW,
		});
	const KEY = 'abcdefghijklmnop0123';
	const KEY_TEST = `dbltest.com.${KEY}.dbl.dq.spamhaus.net`;

	it('reports a domain a list names as listed, with that list', async () => {
		answers['example.com.dbl.spamhaus.org'] = ['127.0.1.2'];

		const results = await check(['example.com']);

		expect(results).toContainEqual(
			expect.objectContaining({ domain: 'example.com', list: 'spamhaus_dbl', status: 'listed' })
		);
		expect(
			results
				.filter((result) => result.status === 'clean')
				.map((r) => r.list)
				.sort()
		).toEqual(['surbl', 'uribl']);
	});

	it('reports a "may not query from here" answer as unknown with its reason', async () => {
		answers['example.com.dbl.spamhaus.org'] = ['127.255.255.254'];
		answers['example.com.multi.uribl.com'] = ['127.0.0.1'];

		const results = await check(['example.com']);

		expect(results).toContainEqual(
			expect.objectContaining({
				list: 'spamhaus_dbl',
				status: 'unknown',
				reason: 'resolver_refused',
			})
		);
		expect(results).toContainEqual(
			expect.objectContaining({ list: 'uribl', status: 'unknown', reason: 'resolver_refused' })
		);
	});

	it('reports a domain no list names as clean on every list', async () => {
		const results = await check(['example.com']);

		expect(results.map((result) => result.status)).toEqual(['clean', 'clean', 'clean']);
	});

	it('answers a repeated check from the cache without querying again', async () => {
		await check(['example.com']);
		const queries = resolve4.mock.calls.length;

		const again = await check(['example.com']);

		expect(resolve4.mock.calls.length).toBe(queries);
		expect(again.map((result) => result.status)).toEqual(['clean', 'clean', 'clean']);
	});

	it('asks Spamhaus through the keyed zone when the key passes its test', async () => {
		answers[KEY_TEST] = ['127.0.1.2'];
		answers[`example.com.${KEY}.dbl.dq.spamhaus.net`] = ['127.0.1.4'];

		const results = await check(['example.com'], KEY);

		expect(results).toContainEqual(
			expect.objectContaining({ list: 'spamhaus_dbl', status: 'listed' })
		);
	});

	it("does not read a rejected key's NXDOMAIN as clean", async () => {
		const results = await check(['example.com'], KEY);

		expect(results).toContainEqual(
			expect.objectContaining({ list: 'spamhaus_dbl', status: 'unknown', reason: 'key_rejected' })
		);
		expect(resolve4.mock.calls.map(([name]) => name)).not.toContain(
			`example.com.${KEY}.dbl.dq.spamhaus.net`
		);
	});

	it('does not trust the key while its test does not answer', async () => {
		const timeout = dnsError('ETIMEOUT');
		resolve4.mockImplementation(async (name: string) => {
			if (name === KEY_TEST) throw timeout;
			throw dnsError('ENOTFOUND');
		});

		const results = await check(['example.com'], KEY);

		expect(results).toContainEqual(
			expect.objectContaining({
				list: 'spamhaus_dbl',
				status: 'unknown',
				reason: 'resolver_unreachable',
			})
		);
	});

	it('does not pass a cached clean Spamhaus answer once the key fails its test', async () => {
		answers[KEY_TEST] = ['127.0.1.2'];
		await check(['example.com'], KEY);
		// The key is revoked, and its cached test result has run out.
		delete answers[KEY_TEST];
		for (const key of await redis.keys('mta:domain-blocklist:dqs-test:*')) await redis.del(key);

		const results = await check(['example.com'], KEY);

		expect(results).toContainEqual(
			expect.objectContaining({ list: 'spamhaus_dbl', status: 'unknown', reason: 'key_rejected' })
		);
	});

	it('asks each list once when two checks for one domain arrive together', async () => {
		await Promise.all([check(['example.com']), check(['example.com'])]);

		expect(resolve4).toHaveBeenCalledTimes(3);
	});
});
