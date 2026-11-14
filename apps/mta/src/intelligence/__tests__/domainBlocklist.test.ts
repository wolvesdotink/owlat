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
	const resolve4 = vi.fn(async (name: string) => {
		const answer = answers[name];
		if (!answer) throw dnsError('ENOTFOUND');
		return answer;
	});

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		answers = {};
		resolve4.mockClear();
	});

	const check = (domains: string[], spamhaus = {}) =>
		checkDomainBlocklists(redis, domains, {
			lookup: { ...createRecordingLookupDeps().deps, resolve4 },
			spamhaus,
			now: () => NOW,
		});

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

	it('asks Spamhaus through the keyed zone when a DQS key is set', async () => {
		answers['example.com.abcdefghijklmnop0123.dbl.dq.spamhaus.net'] = ['127.0.1.4'];

		const results = await check(['example.com'], { dqsKey: 'abcdefghijklmnop0123' });

		expect(results).toContainEqual(
			expect.objectContaining({ list: 'spamhaus_dbl', status: 'listed' })
		);
	});

	it('does not ask Spamhaus at all while the DQS key failed its test', async () => {
		const results = await check(['example.com'], {
			dqsKey: 'abcdefghijklmnop0123',
			unavailable: 'key_rejected',
		});

		expect(results).toContainEqual(
			expect.objectContaining({ list: 'spamhaus_dbl', status: 'unknown', reason: 'key_rejected' })
		);
		expect(resolve4.mock.calls.map(([name]) => name)).not.toContainEqual(
			expect.stringContaining('spamhaus')
		);
	});
});
