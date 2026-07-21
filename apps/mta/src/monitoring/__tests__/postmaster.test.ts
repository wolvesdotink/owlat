import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type { MtaConfig } from '../../config.js';

vi.mock('../../webhooks/convexNotifier.js', () => ({
	notifyPostmasterConvex: vi.fn().mockResolvedValue({
		disposition: 'accepted_authorized',
		retained: true,
	}),
}));
vi.mock('../logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { notifyPostmasterConvex } from '../../webhooks/convexNotifier.js';
import {
	GOOGLE_POSTMASTER_AUTHORIZATION_SCOPES,
	normalizeDomainStat,
} from '../googlePostmasterApi.js';
import { logger } from '../logger.js';
import { fetchPostmasterData, spamRate } from '../postmaster.js';

const config = {
	googlePostmaster: {
		clientId: 'client-id',
		clientSecret: 'client-secret',
		refreshToken: 'refresh-token',
	},
} as MtaConfig;

const FROZEN_NOW = Date.parse('2026-07-21T12:00:00.000Z');

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function response(body: unknown, status = 200, headers: HeadersInit = {}): Response {
	return new Response(body === null ? null : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

function verifiedDomain(name = 'example.com', permission: 'OWNER' | 'ADMIN' | 'READER' = 'OWNER') {
	return {
		name: `domains/${name}`,
		permission,
		verificationState: 'VERIFIED',
	};
}

function spamStat(date = '2026-07-20', ratio = 0.0005) {
	const [year, month, day] = date.split('-').map(Number);
	return {
		metric: 'userReportedSpamRatio',
		date: { year, month, day },
		value: { doubleValue: ratio },
	};
}

describe('Google Postmaster v2 response normalization', () => {
	it('pins the two documented v2 authorization scopes', () => {
		expect(GOOGLE_POSTMASTER_AUTHORIZATION_SCOPES).toEqual([
			'https://www.googleapis.com/auth/postmaster.domain',
			'https://www.googleapis.com/auth/postmaster.traffic.readonly',
		]);
	});

	it('accepts only a finite daily SPAM_RATE value', () => {
		expect(normalizeDomainStat('example.com', spamStat())).toMatchObject({
			event: 'postmaster.stats',
			domain: 'example.com',
			date: '2026-07-20',
			userReportedSpamRatio: 0.0005,
		});
		expect(normalizeDomainStat('example.com', spamStat('2026-02-30'))).toBeNull();
		expect(normalizeDomainStat('example.com', spamStat('2026-07-20', 2))).toBeNull();
		expect(
			normalizeDomainStat('example.com', { ...spamStat(), metric: 'anotherMetric' })
		).toBeNull();
	});
});

describe('Google Postmaster v2 collection', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
		await new Redis().flushall();
		spamRate.reset();
	});

	it('retains operational state only after Convex authorizes the exact domain', async () => {
		const redis = new Redis();
		const unrelatedDomain = 'unrelated-private.example';
		await redis.set(`mta:postmaster:stats-cursor:${unrelatedDomain}`, 'legacy-cursor');
		await redis.set(`mta:postmaster:pushed:${unrelatedDomain}:2026-07-20`, '1');
		spamRate.set({ domain: unrelatedDomain }, 0.99);
		vi.mocked(notifyPostmasterConvex).mockImplementation(async (event) => {
			if (event.domain === unrelatedDomain) {
				return { disposition: 'ignored_unowned', retained: false };
			}
			return { disposition: 'accepted_authorized', retained: event.event === 'postmaster.stats' };
		});
		const statsRequests: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain(unrelatedDomain)],
					});
				}
				statsRequests.push(url);
				return response({ domainStats: [spamStat()] });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(statsRequests).toHaveLength(1);
		expect(statsRequests[0]).toContain('/domains/example.com/');
		expect(await redis.keys('*')).not.toEqual(
			expect.arrayContaining([expect.stringContaining(unrelatedDomain)])
		);
		expect(await spamRate.get()).not.toEqual(
			expect.objectContaining({
				values: expect.arrayContaining([
					expect.objectContaining({ labels: { domain: unrelatedDomain } }),
				]),
			})
		);
		const serializedLogs = JSON.stringify([
			...vi.mocked(logger.warn).mock.calls,
			...vi.mocked(logger.error).mock.calls,
		]);
		expect(serializedLogs).not.toContain(unrelatedDomain);
	});

	it('cleans a domain missing after restart and permits a fresh same-day observation', async () => {
		const redis = new Redis();
		let domainIsListed = true;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({ domains: domainIsListed ? [verifiedDomain()] : [] });
				}
				return response({ domainStats: [spamStat()] });
			})
		);

		await fetchPostmasterData(redis, config);
		expect(await redis.get('mta:postmaster:pushed:example.com:2026-07-20')).toBe('1');
		expect(await redis.zscore('mta:postmaster:domain-state-index', 'example.com')).toBe('1');
		expect(await spamRate.get()).toEqual(
			expect.objectContaining({
				values: expect.arrayContaining([
					expect.objectContaining({ labels: { domain: 'example.com' } }),
				]),
			})
		);

		// A new client proves discovery state is durable rather than process-local.
		domainIsListed = false;
		await fetchPostmasterData(new Redis(), config);

		expect(await redis.get('mta:postmaster:pushed:example.com:2026-07-20')).toBeNull();
		expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
		expect(await redis.zscore('mta:postmaster:domain-state-index', 'example.com')).toBeNull();
		expect(await spamRate.get()).not.toEqual(
			expect.objectContaining({
				values: expect.arrayContaining([
					expect.objectContaining({ labels: { domain: 'example.com' } }),
				]),
			})
		);

		spamRate.reset();
		domainIsListed = true;
		await fetchPostmasterData(redis, config);

		const deliveredStats = vi
			.mocked(notifyPostmasterConvex)
			.mock.calls.filter(([event]) => event.event === 'postmaster.stats');
		expect(deliveredStats).toHaveLength(2);
		expect(await redis.get('mta:postmaster:pushed:example.com:2026-07-20')).toBe('1');
	});

	it('bounds indexed stale-domain cleanup without scanning unrelated Redis keys', async () => {
		const redis = new Redis();
		const staleDomainCount = 250;
		const unrelatedKeyCount = 500;
		const seed = redis.pipeline();
		for (let index = 0; index < staleDomainCount; index++) {
			const domain = `unowned-${index}.example`;
			seed.zadd('mta:postmaster:domain-state-index', 0, domain);
			seed.set(`mta:postmaster:stats-cursor:${domain}`, 'stale');
			seed.set(`mta:postmaster:pushed:${domain}:2026-07-20`, '1');
		}
		for (let index = 0; index < unrelatedKeyCount; index++) {
			seed.set(`unrelated:${index}`, 'keep');
		}
		await seed.exec();
		const scanSpy = vi.spyOn(redis, 'scan');
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes('/token')
					? response({ access_token: 'token', expires_in: 3600 })
					: response({ domains: [] })
			)
		);

		await fetchPostmasterData(redis, config);
		expect(await redis.zcard('mta:postmaster:domain-state-index')).toBe(150);
		await fetchPostmasterData(redis, config);
		expect(await redis.zcard('mta:postmaster:domain-state-index')).toBe(50);
		await fetchPostmasterData(redis, config);

		expect(scanSpy).not.toHaveBeenCalled();
		expect(await redis.zcard('mta:postmaster:domain-state-index')).toBe(0);
		expect(await redis.keys('mta:postmaster:stats-cursor:*')).toEqual([]);
		expect(await redis.keys('mta:postmaster:pushed:*')).toEqual([]);
		expect(await redis.keys('unrelated:*')).toHaveLength(unrelatedKeyCount);
	});

	it('accepts the current v2 ADMIN domain permission', async () => {
		const redis = new Redis();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({ domains: [verifiedDomain('admin.example.com', 'ADMIN')] });
				}
				return response({ domainStats: [spamStat()] });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(notifyPostmasterConvex).toHaveBeenCalledWith(
			expect.objectContaining({ domain: 'admin.example.com' }),
			config,
			{ deadline: expect.any(Number) }
		);
	});

	it('uses the v2 domainStats query and pushes a daily observation once', async () => {
		const redis = new Redis();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('oauth2.googleapis.com/token')) {
				const body = String(init?.body);
				expect(body).toContain('grant_type=refresh_token');
				expect(body).not.toContain('scope=');
				return response({ access_token: 'access-token', expires_in: 3600 });
			}
			if (url.endsWith('/v2/domains?pageSize=25')) {
				expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
				return response({ domains: [verifiedDomain()] });
			}
			if (url.endsWith('/v2/domains/example.com/domainStats:query')) {
				expect(init?.method).toBe('POST');
				expect(JSON.parse(String(init?.body))).toMatchObject({
					metricDefinitions: [
						{
							name: 'userReportedSpamRatio',
							baseMetric: { standardMetric: 'SPAM_RATE' },
						},
					],
					aggregationGranularity: 'DAILY',
					pageSize: 200,
				});
				return response({ domainStats: [spamStat()] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);
		await fetchPostmasterData(redis, config);

		expect(notifyPostmasterConvex).toHaveBeenCalledTimes(3);
		expect(notifyPostmasterConvex).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'postmaster.stats',
				domain: 'example.com',
				userReportedSpamRatio: 0.0005,
			}),
			config,
			{ deadline: expect.any(Number) }
		);
		expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(
			true
		);
		expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/token'))).toHaveLength(1);
	});

	it('follows bounded domain and stats pagination without repeating observations', async () => {
		const redis = new Redis();
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
			if (url.endsWith('/v2/domains?pageSize=25')) {
				return response({ domains: [verifiedDomain()], nextPageToken: 'domain-page-2' });
			}
			if (url.includes('pageToken=domain-page-2')) {
				return response({
					domains: [verifiedDomain('second.example.com')],
				});
			}
			if (url.includes('/domainStats:query')) {
				const request = JSON.parse(String(init?.body)) as { pageToken?: string };
				return request.pageToken
					? response({ domainStats: [spamStat('2026-07-19', 0.002)] })
					: response({ domainStats: [spamStat()], nextPageToken: 'stats-page-2' });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(notifyPostmasterConvex).toHaveBeenCalledTimes(6);
		expect(fetchMock.mock.calls.some(([url]) => String(url).includes('domain-page-2'))).toBe(true);
		expect(
			fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('stats-page-2'))
		).toHaveLength(2);
	});

	it('persists the next domain cursor at the per-sweep safety bound', async () => {
		const redis = new Redis();
		let page = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
			page += 1;
			return response({ domains: [], nextPageToken: `page-${page}` });
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).toHaveBeenCalledTimes(3); // token + two bounded domain pages
		expect(await redis.get('mta:postmaster:domain-cursor')).toBe('page-2');
	});

	it('resumes the persisted domain cursor after a restart and clears it at the end', async () => {
		const redis = new Redis();
		await redis.set('mta:postmaster:domain-cursor', 'persisted-page');
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
			expect(url).toContain('pageToken=persisted-page');
			return response({ domains: [] });
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
	});

	it('clears an invalid persisted domain cursor and retries page one once', async () => {
		const redis = new Redis();
		await redis.set('mta:postmaster:domain-cursor', 'expired-cursor');
		const domainUrls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				domainUrls.push(url);
				return url.includes('expired-cursor')
					? response({ error: { code: 400 } }, 400)
					: response({ domains: [] });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(domainUrls).toHaveLength(2);
		expect(domainUrls[0]).toContain('pageToken=expired-cursor');
		expect(domainUrls[1]).not.toContain('pageToken=');
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
	});

	it('resumes a statistics cursor beyond the per-domain page bound', async () => {
		const redis = new Redis();
		const dates = [
			'2026-07-20',
			'2026-07-19',
			'2026-07-18',
			'2026-07-17',
			'2026-07-16',
			'2026-07-15',
		];
		const requestedStatsTokens: Array<string | undefined> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				const request = JSON.parse(String(init?.body)) as { pageToken?: string };
				requestedStatsTokens.push(request.pageToken);
				const index = request.pageToken ? Number(request.pageToken.slice(5)) : 0;
				return response({
					domainStats: [spamStat(dates[index]!, 0.001 + index / 10_000)],
					...(index + 1 < dates.length ? { nextPageToken: `stats${index + 1}` } : {}),
				});
			})
		);

		await fetchPostmasterData(redis, config);
		expect(
			JSON.parse(String(await redis.get('mta:postmaster:stats-cursor:example.com')))
		).toMatchObject({
			pageToken: 'stats4',
			startDate: '2026-07-14',
			endDate: '2026-07-20',
		});
		await fetchPostmasterData(redis, config);

		expect(requestedStatsTokens).toEqual([
			undefined,
			'stats1',
			'stats2',
			'stats3',
			'stats4',
			'stats5',
		]);
		expect(notifyPostmasterConvex).toHaveBeenCalledTimes(8);
		expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
	});

	it('recovers an invalid persisted statistics cursor from page one', async () => {
		const redis = new Redis();
		await redis.set(
			'mta:postmaster:stats-cursor:example.com',
			JSON.stringify({
				pageToken: 'expired-stats',
				startDate: '2026-07-14',
				endDate: '2026-07-20',
			})
		);
		const requestedStatsTokens: Array<string | undefined> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				const request = JSON.parse(String(init?.body)) as { pageToken?: string };
				requestedStatsTokens.push(request.pageToken);
				return request.pageToken
					? response({ error: { code: 400 } }, 400)
					: response({ domainStats: [spamStat()] });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(requestedStatsTokens).toEqual(['expired-stats', undefined]);
		expect(notifyPostmasterConvex).toHaveBeenCalledTimes(2);
		expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
	});

	it.each([
		['HTTP 400', () => response({ error: { code: 400 } }, 400)],
		['malformed HTTP 200', () => response([])],
	] as const)(
		'aborts a multi-domain page on a fresh statistics-page %s contract failure',
		async (_failureKind, failedResponse) => {
			const redis = new Redis();
			const statsDomains: string[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: string | URL | Request) => {
					const url = String(input);
					if (url.includes('/token')) {
						return response({ access_token: 'token', expires_in: 3600 });
					}
					if (url.includes('/domains?')) {
						return response({
							domains: [verifiedDomain(), verifiedDomain('second.example.com')],
							nextPageToken: 'must-not-checkpoint',
						});
					}
					statsDomains.push(url);
					return failedResponse();
				})
			);

			await fetchPostmasterData(redis, config);

			expect(statsDomains).toHaveLength(1);
			expect(statsDomains[0]).toContain('/domains/example.com/');
			expect(notifyPostmasterConvex).toHaveBeenCalledTimes(1);
			expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
			expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
		}
	);

	it('aborts when page one also rejects after an invalid persisted statistics cursor', async () => {
		const redis = new Redis();
		await redis.set(
			'mta:postmaster:stats-cursor:example.com',
			JSON.stringify({
				pageToken: 'expired-stats',
				startDate: '2026-07-14',
				endDate: '2026-07-20',
			})
		);
		const requestedStatsTokens: Array<string | undefined> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain('second.example.com')],
						nextPageToken: 'must-not-checkpoint',
					});
				}
				const request = JSON.parse(String(init?.body)) as { pageToken?: string };
				requestedStatsTokens.push(request.pageToken);
				return response({ error: { code: 400 } }, 400);
			})
		);

		await fetchPostmasterData(redis, config);

		expect(requestedStatsTokens).toEqual(['expired-stats', undefined]);
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
		expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
	});

	it('never caches an access token beyond a short provider lifetime', async () => {
		const redis = new Redis();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes('/token')
					? response({ access_token: 'short-token', expires_in: 90 })
					: response({ domains: [] })
			)
		);

		await fetchPostmasterData(redis, config);

		const ttl = await redis.ttl('mta:postmaster:oauth-access-token');
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(30);
	});

	it.each([
		['missing', undefined],
		['malformed', '3600'],
		['non-finite', Number.POSITIVE_INFINITY],
		['zero', 0],
		['short', 30],
	] as const)('does not cache a token with a %s lifetime', async (_label, expiresIn) => {
		const redis = new Redis();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) =>
				String(input).includes('/token')
					? response({
							access_token: 'expiring-token',
							...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
						})
					: response({ domains: [] })
			)
		);

		await fetchPostmasterData(redis, config);

		expect(await redis.get('mta:postmaster:oauth-access-token')).toBeNull();
	});

	it('refreshes one rejected access token and retries the request once', async () => {
		const redis = new Redis();
		await redis.set('mta:postmaster:oauth-access-token', 'stale-token');
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/token'))
				return response({ access_token: 'fresh-token', expires_in: 3600 });
			if ((init?.headers as Record<string, string>).Authorization === 'Bearer stale-token') {
				return response({ error: { code: 401 } }, 401);
			}
			return response({ domains: [] });
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(await redis.get('mta:postmaster:oauth-access-token')).toBe('fresh-token');
	});

	it('honors Retry-After and retries a rate-limited request within the bound', async () => {
		const redis = new Redis();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		let domainAttempts = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
			domainAttempts += 1;
			return domainAttempts === 1
				? response({ error: { code: 429 } }, 429, { 'retry-after': '0' })
				: response({ domains: [] });
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(domainAttempts).toBe(2);
	});

	it('waits for the full Retry-After value before retrying', async () => {
		vi.restoreAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(FROZEN_NOW);
		const redis = new Redis();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		let domainAttempts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				if (String(input).includes('/token')) {
					return response({ access_token: 'token', expires_in: 3600 });
				}
				domainAttempts += 1;
				return domainAttempts === 1
					? response({ error: { code: 429 } }, 429, { 'retry-after': '120' })
					: response({ domains: [] });
			})
		);

		const collection = fetchPostmasterData(redis, config);
		await vi.advanceTimersByTimeAsync(119_999);
		expect(domainAttempts).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await collection;

		expect(domainAttempts).toBe(2);
	});

	it('stops the sweep after account-wide rate limiting without checkpointing the page', async () => {
		const redis = new Redis();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const statsDomains: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain('second.example.com')],
						nextPageToken: 'domain-page-2',
					});
				}
				statsDomains.push(url);
				return response({ error: { code: 429 } }, 429, { 'retry-after': '0' });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(statsDomains).toHaveLength(4);
		expect(statsDomains.every((url) => url.includes('/domains/example.com/'))).toBe(true);
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
	});

	it('stops the sweep after a second 401 without querying another domain', async () => {
		const redis = new Redis();
		await redis.set('mta:postmaster:oauth-access-token', 'initial-token');
		const statsDomains: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token'))
					return response({ access_token: 'refreshed-token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain('second.example.com')],
						nextPageToken: 'domain-page-2',
					});
				}
				statsDomains.push(url);
				return response({ error: { code: 401 } }, 401);
			})
		);

		await fetchPostmasterData(redis, config);

		expect(statsDomains).toHaveLength(2);
		expect(statsDomains.every((url) => url.includes('/domains/example.com/'))).toBe(true);
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
	});

	it('stops a multi-domain sweep on insufficient traffic scope without checkpointing', async () => {
		const redis = new Redis();
		const statsDomains: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain('second.example.com')],
						nextPageToken: 'must-not-checkpoint',
					});
				}
				statsDomains.push(url);
				return response(
					{
						error: {
							code: 403,
							status: 'PERMISSION_DENIED',
							details: [
								{
									'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
									reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
									domain: 'googleapis.com',
								},
							],
						},
					},
					403
				);
			})
		);

		await fetchPostmasterData(redis, config);

		expect(statsDomains).toHaveLength(1);
		expect(statsDomains[0]).toContain('/domains/example.com/');
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
		expect(await redis.get('mta:postmaster:stats-cursor:example.com')).toBeNull();
	});

	it('bounds transient server retries', async () => {
		const redis = new Redis();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		let domainAttempts = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				if (String(input).includes('/token')) {
					return response({ access_token: 'token', expires_in: 3600 });
				}
				domainAttempts += 1;
				return response(null, 503, { 'retry-after': '0' });
			})
		);

		await fetchPostmasterData(redis, config);

		expect(domainAttempts).toBe(4); // initial request + three bounded retries
	});

	it('stops issuing work when the absolute collection budget is exhausted', async () => {
		const redis = new Redis();
		let now = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			expect(String(input)).toContain('/token');
			now = 10 * 60 * 1_000;
			return response({ access_token: 'token', expires_in: 3600 });
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not checkpoint a fetched domain page when its processing budget expires', async () => {
		const redis = new Redis();
		let now = FROZEN_NOW;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
			now = FROZEN_NOW + 10 * 60 * 1_000;
			return response({
				domains: [verifiedDomain()],
				nextPageToken: 'must-not-checkpoint',
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await redis.get('mta:postmaster:domain-cursor')).toBeNull();
	});

	it('skips an overlapping sweep while the distributed lease is held', async () => {
		const redis = new Redis();
		await redis.set('mta:postmaster:collection-lock', 'another-worker', 'EX', 60);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('logs a rejected lease acquisition without rejecting the background collection', async () => {
		const redis = new Redis();
		const leaseError = new Error('Redis unavailable');
		vi.spyOn(redis, 'set').mockRejectedValueOnce(leaseError);

		await expect(fetchPostmasterData(redis, config)).resolves.toBeUndefined();

		expect(logger.error).toHaveBeenCalledWith(
			{ operation: 'collection', category: 'unexpected' },
			'Google Postmaster fetch stopped'
		);
	});

	it('never logs an OAuth token attached to Redis command metadata', async () => {
		const redis = new Redis();
		const accessToken = 'sentinel-oauth-access-token-never-log';
		const redisError = Object.assign(new Error('Redis command failed'), {
			code: 'ECONNRESET',
			command: {
				name: 'set',
				args: ['mta:postmaster:oauth-access-token', accessToken, 'EX', '3540'],
			},
		});
		vi.spyOn(redis, 'set').mockResolvedValueOnce('OK').mockRejectedValueOnce(redisError);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => response({ access_token: accessToken, expires_in: 3600 }))
		);

		await expect(fetchPostmasterData(redis, config)).resolves.toBeUndefined();

		const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
		expect(serializedLogs).not.toContain(accessToken);
		expect(serializedLogs).not.toContain('mta:postmaster:oauth-access-token');
		expect(logger.error).toHaveBeenCalledWith(
			{ operation: 'collection', category: 'unexpected' },
			'Google Postmaster fetch stopped'
		);
	});

	it('can acquire a new lease after the previous lease expires', async () => {
		vi.restoreAllMocks();
		const redis = new Redis();
		await redis.set('mta:postmaster:collection-lock', 'expired-worker', 'PX', 1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		const fetchMock = vi.fn(async (input: string | URL | Request) =>
			String(input).includes('/token')
				? response({ access_token: 'token', expires_in: 3600 })
				: response({ domains: [] })
		);
		vi.stubGlobal('fetch', fetchMock);

		await fetchPostmasterData(redis, config);

		expect(fetchMock).toHaveBeenCalled();
	});

	it('does not record a receipt when signed delivery fails', async () => {
		const redis = new Redis();
		vi.mocked(notifyPostmasterConvex)
			.mockResolvedValueOnce({ disposition: 'accepted_authorized', retained: false })
			.mockResolvedValueOnce({ disposition: 'delivery_failed', retained: false })
			.mockResolvedValueOnce({ disposition: 'accepted_authorized', retained: false })
			.mockResolvedValueOnce({ disposition: 'accepted_authorized', retained: true });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				return response({ domainStats: [spamStat()] });
			})
		);

		await fetchPostmasterData(redis, config);
		await fetchPostmasterData(redis, config);

		expect(notifyPostmasterConvex).toHaveBeenCalledTimes(4);
	});
});
