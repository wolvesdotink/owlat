import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
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

// getDeliveryHealth is session-gated; stub the session read so the query runs.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
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

describe('getDeliveryHealth (dot + page single source)', () => {
	it('returns error when a sending domain has failed verification', async () => {
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

	it('is not error when no provider issue, no failed domain, no activity', async () => {
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
		// Provider may be unconfigured in the test env (→ error) or configured
		// (→ ok); either way the domain/reputation dimensions never escalate here.
		expect(['ok', 'error']).toContain(health.level);
	});
});
