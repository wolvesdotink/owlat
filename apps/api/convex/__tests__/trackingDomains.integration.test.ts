import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushScheduled } from './factories';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type * as SsrfGuard from '../lib/ssrfGuard';
import { REGRESSION_CONFIRM_DELAY_MS } from '../domains/lifecycleVerdict';

// The HTTPS probe goes through the SSRF guard's fetch, which resolves the host
// itself; each test answers it here instead, without a network.
const probe = vi.hoisted(() => ({
	answer: (async () => {
		throw new TypeError('fetch failed');
	}) as (url: string) => Promise<Response>,
}));
vi.mock('../lib/ssrfGuard', async () => {
	const actual = await vi.importActual<typeof SsrfGuard>('../lib/ssrfGuard');
	return { ...actual, fetchGuarded: (url: string) => probe.answer(url) };
});

// Pass the org-member floor and the admin gate. requireAdminContext is mocked
// directly because, within sessionOrganization.ts, it calls the real (intra-
// module) getMutationContext — so mocking only the leaf helpers at the module
// boundary doesn't reach it. (Same approach as domainsGating.integration.test.)
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAdminContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

async function insertTrackingDomain(
	t: ReturnType<typeof convexTest>,
	domain = 'track.example.com'
): Promise<Id<'trackingDomains'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('trackingDomains', {
			domain,
			cnameTarget: 'track.owlat.com',
			isVerified: false,
			verifiedAt: undefined,
			createdAt: Date.now(),
		})
	);
}

/** A DNS-over-HTTPS answer naming `target` as the CNAME, or none. */
function dohAnswer(target: string | null): Response {
	const Answer = target === null ? [] : [{ type: 5, data: `${target}.` }];
	return new Response(JSON.stringify({ Status: 0, Answer }), { status: 200 });
}

/** The tracking routes of the deployment under test, reached as the probe would. */
function serveProbeFrom(t: ReturnType<typeof convexTest>): void {
	probe.answer = (url) => t.fetch(new URL(url).pathname, { method: 'GET' });
}

describe('domains.trackingDomains', () => {
	beforeEach(() => {
		// The verify mutation schedules a DNS-over-HTTPS lookup; stub fetch so the
		// scheduled action resolves without touching the network.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ Answer: [] }),
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('verifyTrackingDomain', () => {
		it('returns a truthy success sentinel so the FE can distinguish success from a caught failure', async () => {
			const t = convexTest(schema, modules);
			const id = await insertTrackingDomain(t);

			// This return value is load-bearing: the Operation module's run()
			// resolves to `undefined` on a caught error, so the FE keys its success
			// UX (auto-expand row + "Checking DNS…" toast) off `result !== undefined`.
			const result = await t.mutation(api.domains.trackingDomains.verifyTrackingDomain, {
				trackingDomainId: id,
			});

			expect(result).toEqual({ success: true });
			expect(result).not.toBeUndefined();

			await flushScheduled(t);
		});

		it('throws (not undefined-returns) for an unknown tracking domain', async () => {
			const t = convexTest(schema, modules);

			await expect(
				t.mutation(api.domains.trackingDomains.verifyTrackingDomain, {
					trackingDomainId: 'nonexistent' as Id<'trackingDomains'>,
				})
			).rejects.toThrow();
		});
	});

	describe('addTrackingDomain', () => {
		it('refuses anything but a hostname', async () => {
			const t = convexTest(schema, modules);
			for (const domain of [
				'track.example.com:8443',
				'track.example.com/x',
				'a@track.example.com',
			]) {
				await expect(
					t.mutation(api.domains.trackingDomains.addTrackingDomain, { domain })
				).rejects.toThrow(/domain name/);
			}
		});
	});

	describe('removeTrackingDomain', () => {
		it('deletes the domain and returns a truthy success sentinel', async () => {
			const t = convexTest(schema, modules);
			const id = await insertTrackingDomain(t, 'track-delete.example.com');

			// Sentinel lets the FE reach close-modal + success-toast (run() yields
			// `undefined` on error, so a void return would look like a failure).
			const result = await t.mutation(api.domains.trackingDomains.removeTrackingDomain, {
				trackingDomainId: id,
			});

			expect(result).toEqual({ success: true });
			expect(result).not.toBeUndefined();

			await t.run(async (ctx) => {
				expect(await ctx.db.get(id)).toBeNull();
			});
		});
	});
});

describe('tracking domain verification', () => {
	const SAVED_ENV = { ...process.env };

	beforeEach(() => {
		process.env['UNSUBSCRIBE_SECRET'] = 'tracking-domain-test-secret';
		probe.answer = async () => {
			throw new TypeError('fetch failed', { cause: new Error('certificate has expired') });
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		process.env = { ...SAVED_ENV };
	});

	// The confirming check is an hour after the first failure: pin the clock so
	// the test can step it. The scheduled-job drain needs the real clock, so
	// only the tests that call the check directly pin it.
	function pinClock(): void {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 10, 1, 12, 0, 0));
	}

	function harness(): ReturnType<typeof convexTest> {
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		return t;
	}

	const row = (t: ReturnType<typeof convexTest>, id: Id<'trackingDomains'>) =>
		t.run((ctx) => ctx.db.get(id));

	const check = (t: ReturnType<typeof convexTest>, trackingDomainId: Id<'trackingDomains'>) =>
		t.action(internal.domains.trackingDomainCheck.checkTrackingDomain, { trackingDomainId });

	async function insertVerified(t: ReturnType<typeof convexTest>): Promise<Id<'trackingDomains'>> {
		return t.run((ctx) =>
			ctx.db.insert('trackingDomains', {
				domain: 'track.example.com',
				cnameTarget: 'track.owlat.com',
				isVerified: true,
				verifiedAt: Date.now() - 86_400_000,
				createdAt: Date.now() - 86_400_000,
			})
		);
	}

	it('leaves the domain unverified, naming HTTPS, when the CNAME matches but the host has no working certificate', async () => {
		const t = harness();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => dohAnswer('track.owlat.com'))
		);
		const id = await insertTrackingDomain(t);

		await t.mutation(api.domains.trackingDomains.verifyTrackingDomain, { trackingDomainId: id });
		await flushScheduled(t);

		const td = await row(t, id);
		expect(td?.isVerified).toBe(false);
		expect(td?.lastCheck?.outcome).toBe('https_unreachable');
	});

	it('leaves the domain unverified, naming DNS, when the CNAME points elsewhere', async () => {
		const t = harness();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => dohAnswer('elsewhere.example.net'))
		);
		serveProbeFrom(t);
		const id = await insertTrackingDomain(t);

		await t.mutation(api.domains.trackingDomains.verifyTrackingDomain, { trackingDomainId: id });
		await flushScheduled(t);

		const td = await row(t, id);
		expect(td?.isVerified).toBe(false);
		expect(td?.lastCheck?.outcome).toBe('dns_mismatch');
	});

	it("verifies the domain when the CNAME matches and the host serves this deployment's probe", async () => {
		const t = harness();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => dohAnswer('track.owlat.com'))
		);
		serveProbeFrom(t);
		const id = await insertTrackingDomain(t);

		await t.mutation(api.domains.trackingDomains.verifyTrackingDomain, { trackingDomainId: id });
		await flushScheduled(t);

		const td = await row(t, id);
		expect(td?.isVerified).toBe(true);
		expect(td?.lastCheck?.outcome).toBe('verified');
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((entry) => entry.action)).toContain('tracking_domain.verified');
	});

	it('stops using a verified domain after two failing checks, and a send from its domain falls back to the default', async () => {
		pinClock();
		const t = harness();
		const id = await insertVerified(t);
		const forSender = () =>
			t.query(internal.domains.trackingDomains.getTrackingDomainForSender, {
				from: 'Newsletter <news@example.com>',
			});
		expect(await forSender()).toBe('track.example.com');

		// The CNAME still matches; the proxy no longer answers over HTTPS.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => dohAnswer('track.owlat.com'))
		);
		await check(t, id);
		expect(await row(t, id)).toMatchObject({
			isVerified: true,
			regressionSuspectedAt: Date.now(),
			lastCheck: { outcome: 'https_unreachable' },
		});
		expect(await forSender()).toBe('track.example.com');

		vi.setSystemTime(Date.now() + REGRESSION_CONFIRM_DELAY_MS);
		await check(t, id);

		const td = await row(t, id);
		expect(td?.isVerified).toBe(false);
		expect(td?.regressionSuspectedAt).toBeUndefined();
		expect(await forSender()).toBeNull();
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((entry) => entry.action)).toContain('tracking_domain.verification_failed');
	});

	it('changes nothing when the resolver fails', async () => {
		pinClock();
		const t = harness();
		const id = await insertVerified(t);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
		);

		await check(t, id);
		vi.setSystemTime(Date.now() + REGRESSION_CONFIRM_DELAY_MS);
		await check(t, id);

		const td = await row(t, id);
		expect(td?.isVerified).toBe(true);
		expect(td?.regressionSuspectedAt).toBeUndefined();
		expect(td?.lastCheck?.outcome).toBe('inconclusive');
	});

	it('is re-checked by the daily sweep once it was ever verified', async () => {
		const t = harness();
		await insertVerified(t);
		await insertTrackingDomain(t, 'never.example.com');

		await t.mutation(internal.domains.reverificationSweep.scheduleReverification, {});

		const names = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
		);
		expect(names.filter((name) => name.includes('trackingDomainCheck'))).toHaveLength(1);
	});
});
