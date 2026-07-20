import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

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
		expect(typeof health.reason).toBe('string');
		expect(health.reason.length).toBeGreaterThan(0);
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
			reason: 'Mail server infrastructure is degraded',
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
});
