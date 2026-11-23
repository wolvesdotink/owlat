import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { createTestCampaign } from '../../__tests__/factories';
import { DELIVERY_HEALTH_EXPLANATIONS } from '../healthCopy';
import { MTA_HEALTH_MAX_AGE_MS, MTA_HEALTH_RESTAMP_MS } from '../mtaHealthFreshness';

/**
 * Roll-up agreement: the sidebar Delivery dot and the Delivery health page's
 * header verdict chip read the SAME `delivery.health.getDeliveryHealth` query,
 * so they can never disagree. This exercises that one query end-to-end against a
 * real DB and confirms it composes the shared `rollUpDeliveryHealth` verdict
 * (worst-of provider/domain/reputation) — a failed sending domain forces an
 * `error` level whatever the other dimensions say.
 */

// getDeliveryHealth runs behind the authedQuery wrapper, which calls
// requireOrgMember. Mirror delivery/status.test.ts and stub the org-membership
// reads (plus the session read the handler makes) so the query runs.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'owner' }),
	};
});

// Same glob-merge shape as delivery/status.test.ts: `../../**` from
// `delivery/__tests__` omits the sibling `delivery/*` modules, so re-add them.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

// The provider dimension reads sending-provider env; pin it so the roll-up level
// is deterministic instead of leaking the CI host's ambient config.
const ENV_KEYS = [
	'EMAIL_PROVIDER',
	'MTA_API_URL',
	'MTA_API_KEY',
	'RESEND_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
] as const;

const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
	for (const k of ENV_KEYS) delete process.env[k];
	for (const [k, value] of Object.entries(patch)) {
		if (value !== undefined) process.env[k] = value;
	}
}

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (original[k] === undefined) delete process.env[k];
		else process.env[k] = original[k];
	}
});

describe('getDeliveryHealth (dot + page single source)', () => {
	it('returns error when a sending domain has failed verification', async () => {
		// Fully-configured provider, so the failed domain is the only escalation.
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'failed',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health.level).toBe('error');
		expect(health.reasonCode).toBe('domain_failed');
	});

	it('is ok when the provider is configured, no failed domain, no activity', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: {
					status: 'ok',
					isRedisConnected: true,
					isWorkerAlive: true,
					isDnsReachable: true,
					isAllIpsBlocked: false,
					smtpOutbound: {
						status: 'ok',
						checkedAt: Date.now(),
						ips: [{ ip: '192.0.2.10', status: 'ok' }],
					},
					observedAt: Date.now(),
				},
				defaultFromEmail: 'hello@mail.example.com',
				createdAt: Date.now(),
			});
			await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		// Provider configured, domain verified, no in-window activity → nothing
		// escalates, so the roll-up is deterministically healthy.
		expect(health.level).toBe('ok');
	});

	it('returns error when the MTA reports degraded infrastructure', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: {
					status: 'degraded',
					isRedisConnected: true,
					isWorkerAlive: true,
					isDnsReachable: true,
					isAllIpsBlocked: false,
					smtpOutbound: {
						status: 'degraded',
						checkedAt: Date.now(),
						ips: [{ ip: '192.0.2.10', status: 'failed', reason: 'network_unreachable' }],
					},
					observedAt: Date.now(),
				},
				createdAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({
			level: 'error',
			reasonCode: 'mta_degraded',
		});
	});

	it('names the sending domain whose mail the MTA holds for a missing DKIM key', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: {
					status: 'degraded',
					isRedisConnected: true,
					isWorkerAlive: true,
					isDnsReachable: true,
					isAllIpsBlocked: false,
					smtpOutbound: { status: 'ok', checkedAt: Date.now(), ips: [] },
					dkimSigningHeld: [{ domain: 'mail.example.com', cause: 'no_key', since: Date.now() }],
					observedAt: Date.now(),
				},
				createdAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({
			level: 'error',
			reasonCode: 'mta_signing_held',
			reasonParams: { domains: 'mail.example.com' },
		});
	});

	it('returns error when the sending provider is unconfigured', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		// A verified domain can't send if no provider is configured — the provider
		// dimension escalates the roll-up on its own.
		expect(health.level).toBe('error');
	});

	/** A healthy MTA snapshot last written `ageMs` ago, next to a verified domain. */
	async function seedHealthySnapshot(t: ReturnType<typeof convexTest>, ageMs: number) {
		const observedAt = Date.now() - ageMs;
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: {
					status: 'ok',
					isRedisConnected: true,
					isWorkerAlive: true,
					isDnsReachable: true,
					isAllIpsBlocked: false,
					smtpOutbound: {
						status: 'ok',
						checkedAt: observedAt,
						ips: [{ ip: '192.0.2.10', status: 'ok' }],
					},
					observedAt,
				},
				defaultFromEmail: 'hello@mail.example.com',
				createdAt: observedAt,
			});
			await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}

	it('stays ok while an unchanged snapshot waits for its re-stamp', async () => {
		// `mtaHealth.record` skips unchanged polls until the re-stamp interval, so
		// a healthy snapshot can be older than one poll without the sync failing.
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedHealthySnapshot(t, MTA_HEALTH_RESTAMP_MS + 60_000);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health.level).toBe('ok');
	});

	it('warns once the snapshot is older than the freshness window', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedHealthySnapshot(t, MTA_HEALTH_MAX_AGE_MS + 60_000);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'warn', reasonCode: 'mta_stale' });
	});

	/** A provider-configured MTA instance with a fresh healthy snapshot and a verified sender. */
	async function seedReadyMtaInstance(
		t: ReturnType<typeof convexTest>,
		settings: {
			defaultFromEmail?: string;
			transactionalFromEmail?: string;
			abuseStatus?: 'clean' | 'warned' | 'suspended' | 'banned';
		} = {
			defaultFromEmail: 'hello@mail.example.com',
		}
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: { status: 'ok', observedAt: Date.now() },
				...settings,
				createdAt: Date.now(),
			});
			await ctx.db.insert('domains', {
				domain: 'mail.example.com',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}

	function warmingIp(ip: string, pool: string, held: boolean) {
		return {
			ip,
			phase: 'ramp',
			currentDay: 3,
			dailyCap: 500,
			sentToday: 0,
			bounceRate: 0,
			deferralRate: 0,
			pool,
			active: true,
			...(held ? { blockReasons: ['dnsbl' as const] } : {}),
		};
	}

	async function seedWarming(
		t: ReturnType<typeof convexTest>,
		phase: string,
		ips: ReturnType<typeof warmingIp>[],
		pools?: { transactional: string[]; campaign: string[] }
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('warmingState', {
				...(pools ? { pools } : {}),
				phase,
				totalDailyCap: 1000,
				totalSentToday: 0,
				ipCount: ips.length,
				ips,
				syncedAt: Date.now(),
			});
		});
	}

	it('errors when no default sender is set, since every transactional send needs one', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t, {});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({
			level: 'error',
			reasonCode: 'sender_missing',
		});
	});

	it('errors with the suspension when sending is suspended, though every check is green', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t, {
			defaultFromEmail: 'hello@mail.example.com',
			abuseStatus: 'suspended',
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'error', reasonCode: 'sending_suspended' });
	});

	it('errors with the ban when sending is banned', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t, {
			defaultFromEmail: 'hello@mail.example.com',
			abuseStatus: 'banned',
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'error', reasonCode: 'sending_banned' });
	});

	it("errors when the default sender's domain is not verified", async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t, { defaultFromEmail: 'hello@unverified.example' });

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health.level).toBe('error');
		expect(health.reasonCode).toBe('sender_unverified');
	});

	it('follows the transactional sender: errors when its domain is not verified, even with a verified default', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t, {
			defaultFromEmail: 'hello@mail.example.com',
			transactionalFromEmail: 'account@txn.unverified.example',
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health.reasonCode).toBe('sender_unverified');
	});

	it('errors when every IP of a pool the MTA carries is held', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t);
		await seedWarming(t, 'ramp', [
			warmingIp('192.0.2.10', 'campaign', true),
			warmingIp('192.0.2.11', 'transactional', false),
		]);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'error', reasonCode: 'ips_all_held' });
	});

	it('reads pool membership from the pool lists, not the first-pool label on each row', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t);
		// 192.0.2.10 serves both pools but its row names only `transactional`.
		await seedWarming(
			t,
			'ramp',
			[warmingIp('192.0.2.10', 'transactional', false), warmingIp('192.0.2.11', 'campaign', true)],
			{ transactional: ['192.0.2.10'], campaign: ['192.0.2.10', '192.0.2.11'] }
		);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'warn', reasonCode: 'ips_some_held' });
	});

	it('warns when the campaign warm-up is halted', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t);
		await seedWarming(t, 'plateau', [warmingIp('192.0.2.10', 'campaign', false)]);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({ level: 'warn', reasonCode: 'warmup_halted' });
	});

	it('ignores held IPs and a halted warm-up when no stream is sent through the MTA', async () => {
		setEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t);
		await seedWarming(t, 'plateau', [warmingIp('192.0.2.10', 'campaign', true)]);

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health.level).toBe('ok');
	});

	it('errors when only campaigns have a route and transactional mail has no transport', async () => {
		setEnv({ RESEND_API_KEY: 're_test' });
		const t = convexTest(schema, modules);
		await seedReadyMtaInstance(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'resend', isEnabled: true }],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const health = await t.query(api.delivery.health.getDeliveryHealth, {});
		expect(health).toEqual({
			level: 'error',
			reasonCode: 'no_provider_transactional',
		});
	});
});

/**
 * The assistant's delivery-health read: the same roll-up the sidebar dot shows,
 * explained in a sentence, with the facts behind it that members can already
 * read (domain verification, the org's rates, the sending hold).
 */
describe('assistant deliveryHealth', () => {
	const SUSPENDED_AT = Date.UTC(2026, 10, 20, 9, 0, 0);
	const REASON =
		'Auto-suspended: Gmail reports a spam rate of 0.42% for mail.example.com on 2026-11-19';

	async function seed(
		t: ReturnType<typeof convexTest>,
		opts: {
			extraDomains?: { domain: string; status: 'pending' | 'failed' }[];
			settings?: Record<string, unknown>;
			reputation?: { sent: number; bounced: number; complaints: number };
		} = {}
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				mtaHealth: { status: 'ok', observedAt: Date.now() },
				defaultFromEmail: 'hello@mail.example.com',
				...opts.settings,
				createdAt: Date.now(),
			});
			for (const { domain, status } of [
				{ domain: 'mail.example.com', status: 'verified' as const },
				...(opts.extraDomains ?? []),
			]) {
				await ctx.db.insert('domains', {
					domain,
					status,
					dnsRecords: {},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
			if (opts.reputation) {
				const { sent, bounced, complaints } = opts.reputation;
				await ctx.db.insert('sendingReputation', {
					scope: 'org',
					periodStart: Date.now() - (Date.now() % 86_400_000),
					shardKey: 0,
					totalSent: sent,
					totalDelivered: sent - bounced,
					totalBounced: bounced,
					totalHardBounced: bounced,
					totalComplaints: complaints,
					lastCalculatedAt: Date.now(),
				});
			}
		});
	}

	it('reports a healthy instance with its domains and nothing held', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t);

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health).toEqual({
			level: 'ok',
			reasonCode: 'healthy',
			explanation: DELIVERY_HEALTH_EXPLANATIONS.healthy.sentence,
			fix: null,
			domains: [{ domain: 'mail.example.com', status: 'verified' }],
			rates: null,
			sendHold: null,
		});
	});

	it('names a failed domain and where to fix it', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, { extraDomains: [{ domain: 'news.example.com', status: 'failed' }] });

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health).toMatchObject({
			level: 'error',
			reasonCode: 'domain_failed',
			explanation: DELIVERY_HEALTH_EXPLANATIONS.domain_failed.sentence,
			fix: { route: '/dashboard/admin/delivery/domains', who: 'workspace_admin' },
		});
		expect(health.domains).toEqual(
			expect.arrayContaining([
				{ domain: 'mail.example.com', status: 'verified' },
				{ domain: 'news.example.com', status: 'failed' },
			])
		);
	});

	it('returns the recorded reason and since-when of a suspension', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, {
			settings: {
				abuseStatus: 'suspended',
				abuseStatusReason: REASON,
				abuseStatusChangedAt: SUSPENDED_AT,
				abuseStatusChangedBy: 'system',
			},
		});

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health).toMatchObject({
			level: 'error',
			reasonCode: 'sending_suspended',
			fix: { route: '/dashboard/admin/operator', who: 'platform_admin' },
			sendHold: {
				status: 'suspended',
				reason: REASON,
				since: new Date(SUSPENDED_AT).toISOString(),
			},
		});
	});

	it('keeps no stale reason once sending is allowed again', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, {
			settings: { abuseStatus: 'clean', abuseStatusReason: REASON, abuseStatusChangedAt: 1 },
		});

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health.sendHold).toBeNull();
	});

	it('flags the bounce and complaint rates that are over their limits', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, { reputation: { sent: 1000, bounced: 60, complaints: 2 } });

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health.rates).toEqual({
			windowDays: 30,
			sent: 1000,
			bounce: { ratePct: 6, limitPct: 2, isOver: true },
			complaint: { ratePct: 0.2, limitPct: 0.1, isOver: true },
		});
	});

	it('leaves rates under their limits unflagged', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, { reputation: { sent: 1000, bounced: 10, complaints: 0 } });

		const health = await t.query(internal.assistant.insights.deliveryHealth, {});
		expect(health.rates).toMatchObject({
			bounce: { ratePct: 1, isOver: false },
			complaint: { ratePct: 0, isOver: false },
		});
	});

	it("carries the suspension's reason on a held campaign's sendHold", async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await seed(t, {
			settings: {
				abuseStatus: 'suspended',
				abuseStatusReason: REASON,
				abuseStatusChangedAt: SUSPENDED_AT,
			},
		});
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					name: 'Spring sale',
					searchableText: 'spring sale',
					status: 'sending',
				}) as never
			);
		});

		const { campaigns } = await t.query(internal.assistant.insights.campaignStats, {
			query: 'spring',
		});
		expect(campaigns[0]?.sendHold).toMatchObject({
			kind: 'held',
			status: 'suspended',
			reason: REASON,
		});
	});
});
