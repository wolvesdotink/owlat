/**
 * Google Postmaster Tools v2 wire parsing and the shape the collector delivers.
 *
 * Every case here is a real thing Google does: withholding a metric on a
 * low-traffic day, adding a check name we have never seen, returning a day with
 * no usable rows at all — plus the hostile variants a compromised or confused
 * upstream could produce.
 */
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
import { POSTMASTER_MAX_COMPLIANCE_CHECKS } from '@owlat/shared/mtaWebhookEvent';
import {
	POSTMASTER_RATIO_METRICS,
	normalizeDomainStat,
	parseComplianceStatus,
} from '../googlePostmasterApi.js';
import { logger } from '../logger.js';
import { fetchPostmasterData } from '../postmaster.js';

const config = {
	googlePostmaster: {
		clientId: 'client-id',
		clientSecret: 'client-secret',
		refreshToken: 'refresh-token',
	},
} as MtaConfig;

const FROZEN_NOW = Date.parse('2026-07-21T12:00:00.000Z');
const YESTERDAY = '2026-07-20';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function response(body: unknown, status = 200): Response {
	return new Response(body === null ? null : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function stat(metric: string, ratio: number, date = YESTERDAY) {
	const [year, month, day] = date.split('-').map(Number);
	return { metric, date: { year, month, day }, value: { doubleValue: ratio } };
}

function verifiedDomain(name = 'example.com') {
	return { name: `domains/${name}`, permission: 'OWNER', verificationState: 'VERIFIED' };
}

interface CollectedEvent {
	event: string;
	domain: string;
	date: string;
	userReportedSpamRatio?: number;
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrorRatio?: number;
	deliveryErrors?: Array<{ category: string; ratio: number }>;
	checks?: Array<{ name: string; state: string }>;
}

function collected(): CollectedEvent[] {
	return vi
		.mocked(notifyPostmasterConvex)
		.mock.calls.map(([event]) => event as unknown as CollectedEvent);
}

describe('Postmaster v2 metric definitions', () => {
	it('requests spam, authentication and delivery-error rates in one query', () => {
		expect(POSTMASTER_RATIO_METRICS.map((metric) => metric.standardMetric)).toEqual([
			'SPAM_RATE',
			'SPF_SUCCESS_RATE',
			'DKIM_SUCCESS_RATE',
			'DMARC_SUCCESS_RATE',
			'DELIVERY_ERROR_RATE',
		]);
	});

	it('keeps every requested metric and drops metrics it never asked for', () => {
		for (const metric of POSTMASTER_RATIO_METRICS) {
			expect(normalizeDomainStat(stat(metric.name, 0.5))).toEqual({
				date: YESTERDAY,
				metric: metric.name,
				ratio: 0.5,
			});
		}
		// Forward compatibility: a metric Google adds is ignored, never fatal.
		expect(normalizeDomainStat(stat('someMetricFromTheFuture', 0.5))).toBeNull();
		expect(normalizeDomainStat(stat('userReportedSpamRatio', 1.5))).toBeNull();
		expect(normalizeDomainStat({ metric: 'userReportedSpamRatio' })).toBeNull();
	});
});

describe('Postmaster v2 compliance status parsing', () => {
	it('normalizes documented states and retains unknown check names', () => {
		expect(
			parseComplianceStatus({
				checks: [
					{ name: 'SPAM_RATE', state: 'PASSING' },
					{ name: 'DOMAIN_REPUTATION', state: 'FAILING' },
					{ name: 'SOME_NEW_CHECK', state: 'A_STATE_WE_DO_NOT_KNOW' },
				],
			})
		).toEqual([
			{ name: 'SPAM_RATE', state: 'passing' },
			{ name: 'DOMAIN_REPUTATION', state: 'failing' },
			{ name: 'SOME_NEW_CHECK', state: 'unknown' },
		]);
	});

	it('never throws on a missing, empty or malformed payload', () => {
		for (const payload of [
			undefined,
			null,
			42,
			'checks',
			[],
			{},
			{ checks: null },
			{ checks: 'SPAM_RATE' },
			{ checks: [null, 7, 'SPAM_RATE', {}] },
		]) {
			expect(parseComplianceStatus(payload)).toEqual([]);
		}
	});

	it('bounds a hostile payload and never stores an injectable name', () => {
		const hostile = {
			checks: [
				// 10k entries, all distinct, plus repeats of a legitimate one.
				...Array.from({ length: 10_000 }, (_, index) => ({
					name: `CHECK_${index}`,
					state: 'FAILING',
				})),
				{ name: 'SPAM_RATE', state: 'FAILING' },
				{ name: 'SPAM_RATE', state: 'PASSING' },
				{ name: '<script>alert(1)</script>', state: 'FAILING' },
				{ name: `A${'B'.repeat(500)}`, state: 'FAILING' },
				{ name: 'has spaces', state: 'FAILING' },
			],
		};
		const checks = parseComplianceStatus(hostile);
		expect(checks).toHaveLength(POSTMASTER_MAX_COMPLIANCE_CHECKS);
		expect(checks.every((check) => /^[A-Z0-9_]{1,64}$/.test(check.name))).toBe(true);
		expect(new Set(checks.map((check) => check.name)).size).toBe(checks.length);
	});
});

describe('Postmaster v2 collection into the stored shape', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
		await new Redis().flushall();
	});

	it('folds every metric of a day into one event and pushes the compliance verdict', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				if (url.endsWith('/complianceStatus')) {
					return response({ checks: [{ name: 'SPAM_RATE', state: 'FAILING' }] });
				}
				const body = String(init?.body);
				if (body.includes('deliveryError.')) {
					return response({
						domainStats: [stat('deliveryError.RATE_LIMIT_EXCEEDED', 0.02)],
					});
				}
				return response({
					domainStats: [
						stat('userReportedSpamRatio', 0.0005),
						stat('spfSuccessRatio', 0.99),
						stat('dkimSuccessRatio', 0.98),
						stat('dmarcSuccessRatio', 0.97),
						stat('deliveryErrorRatio', 0.02),
					],
				});
			})
		);

		await fetchPostmasterData(new Redis(), config);

		const stats = collected().filter((event) => event.event === 'postmaster.stats');
		expect(stats).toEqual([
			expect.objectContaining({
				event: 'postmaster.stats',
				domain: 'example.com',
				date: YESTERDAY,
				userReportedSpamRatio: 0.0005,
				spfSuccessRatio: 0.99,
				dkimSuccessRatio: 0.98,
				dmarcSuccessRatio: 0.97,
				deliveryErrorRatio: 0.02,
				deliveryErrors: [{ category: 'RATE_LIMIT_EXCEEDED', ratio: 0.02 }],
			}),
		]);
		expect(collected().filter((event) => event.event === 'postmaster.compliance')).toEqual([
			expect.objectContaining({
				domain: 'example.com',
				checks: [{ name: 'SPAM_RATE', state: 'failing' }],
			}),
		]);
	});

	it('delivers a partial day, skips a day with no spam rate, and pushes nothing for an empty response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				if (url.endsWith('/complianceStatus')) return response({});
				return response({
					domainStats: [
						// A day Google reported the spam rate for but nothing else.
						stat('userReportedSpamRatio', 0.001),
						// A day with only an authentication rate — not yet reportable.
						stat('dkimSuccessRatio', 0.9, '2026-07-19'),
					],
				});
			})
		);

		await fetchPostmasterData(new Redis(), config);

		const stats = collected().filter((event) => event.event === 'postmaster.stats');
		expect(stats).toHaveLength(1);
		expect(stats[0]).toMatchObject({ date: YESTERDAY, userReportedSpamRatio: 0.001 });
		expect(stats[0]).not.toHaveProperty('spfSuccessRatio');
		expect(stats[0]).not.toHaveProperty('deliveryErrors');
		// An empty compliance payload is silence, not a failure.
		expect(collected().some((event) => event.event === 'postmaster.compliance')).toBe(false);
	});

	it('keeps the day when the delivery-error breakdown is rejected', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				if (url.endsWith('/complianceStatus')) return response({}, 403);
				const body = String(init?.body);
				if (body.includes('deliveryError.')) return response({ error: { code: 400 } }, 400);
				return response({
					domainStats: [stat('userReportedSpamRatio', 0.001), stat('deliveryErrorRatio', 0.05)],
				});
			})
		);

		await fetchPostmasterData(new Redis(), config);

		const stats = collected().filter((event) => event.event === 'postmaster.stats');
		expect(stats).toHaveLength(1);
		expect(stats[0]).toMatchObject({ deliveryErrorRatio: 0.05 });
		expect(stats[0]).not.toHaveProperty('deliveryErrors');
	});
});

describe('Postmaster v2 compliance collection is additive, never load-bearing', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		// Restated rather than inherited: one case below replaces the disposition.
		vi.mocked(notifyPostmasterConvex).mockResolvedValue({
			disposition: 'accepted_authorized',
			retained: true,
		});
		vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
		await new Redis().flushall();
	});

	it('does not ask Google about a domain whose authorization was just lost', async () => {
		vi.mocked(notifyPostmasterConvex).mockImplementation(async (event) =>
			event.event === 'postmaster.stats'
				? { disposition: 'ignored_unowned', retained: false }
				: { disposition: 'accepted_authorized', retained: false }
		);
		const requestedUrls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				requestedUrls.push(url);
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				if (url.endsWith('/complianceStatus')) {
					return response({ checks: [{ name: 'SPAM_RATE', state: 'FAILING' }] });
				}
				return response({ domainStats: [stat('userReportedSpamRatio', 0.001)] });
			})
		);

		await fetchPostmasterData(new Redis(), config);

		expect(requestedUrls.some((url) => url.endsWith('/complianceStatus'))).toBe(false);
		expect(collected().some((event) => event.event === 'postmaster.compliance')).toBe(false);
	});

	it('reports an unavailable Compliance Status once a day rather than every sweep', async () => {
		const redis = new Redis();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) return response({ domains: [verifiedDomain()] });
				if (url.endsWith('/complianceStatus')) {
					return response({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403);
				}
				return response({ domainStats: [stat('userReportedSpamRatio', 0.001)] });
			})
		);

		await fetchPostmasterData(redis, config);
		await fetchPostmasterData(redis, config);

		const complianceWarnings = vi
			.mocked(logger.warn)
			.mock.calls.filter((call) => JSON.stringify(call).includes('domains.complianceStatus'));
		expect(complianceWarnings).toHaveLength(1);
		expect(logger.error).not.toHaveBeenCalled();
		// The statistics half of the sweep is untouched by the missing permission.
		expect(collected().filter((event) => event.event === 'postmaster.stats')).toHaveLength(1);
	});

	it('lets run-budget exhaustion stop the sweep instead of swallowing it', async () => {
		let now = FROZEN_NOW;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes('/token')) return response({ access_token: 'token', expires_in: 3600 });
				if (url.includes('/domains?')) {
					return response({
						domains: [verifiedDomain(), verifiedDomain('second.example.com')],
					});
				}
				// The statistics push consumed the whole run budget.
				now = FROZEN_NOW + 10 * 60 * 1_000;
				return response({ domainStats: [stat('userReportedSpamRatio', 0.001)] });
			})
		);

		await fetchPostmasterData(new Redis(), config);

		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ category: 'budget' }),
			'Google Postmaster fetch stopped'
		);
		expect(vi.mocked(logger.warn).mock.calls).toEqual([]);
	});
});
