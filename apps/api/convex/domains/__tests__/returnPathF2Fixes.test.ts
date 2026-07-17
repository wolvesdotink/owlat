/**
 * Return-path lifecycle/DNS-contract fixes — post-merge adversarial review (F2).
 *
 *   Finding 1 — return-path host is ATOMIC with create: creating a domain WITH a
 *     custom host and then completing registration lands the FULL DKIM/DMARC
 *     bundle + provider identity AND the custom mailFrom records — never the
 *     `pending → pending` self-loop that dropped the bundle.
 *   Finding 2 — the MTA return-path bundle carries an MX (bounce-DSN routing) in
 *     addition to the SPF TXT, and verification targets both.
 *   Finding 3 — the Convex boundary rejects the hosts the shared validator
 *     rejects (`localhost`, `_bounce.example.com`) that the laxer `asDnsName`
 *     used to accept.
 *   Finding 4 — an out-of-order reflection completion converges the provider on
 *     the LAST edit's host (requeues) instead of silently sticking on an earlier.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { buildReturnPathMailFromRecords, RETURN_PATH_MX_PRIORITY } from '../spf';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: 'owner' as const });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ctx()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn(async () => ctx()),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
		requireOrgPermission: vi.fn(async () => ctx()),
	};
});

const registerDomainMock = vi.fn();
vi.mock('../../lib/emailProviders/mtaIdentity', async (importActual) => {
	const actual = await importActual<typeof import('../../lib/emailProviders/mtaIdentity')>();
	return {
		...actual,
		createMtaIdentityManager: () => ({
			registerDomain: registerDomainMock,
			deleteDomain: vi.fn(),
		}),
	};
});

const resolveTxtMock = vi.fn();
const resolveMxMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	default: {
		resolveTxt: (host: string) => resolveTxtMock(host),
		resolveMx: (host: string) => resolveMxMock(host),
		resolveCname: vi.fn().mockRejectedValue(new Error('no cname')),
		resolve: vi.fn().mockRejectedValue(new Error('no record')),
		resolve4: vi.fn().mockRejectedValue(new Error('no a')),
		reverse: vi.fn().mockRejectedValue(new Error('no ptr')),
	},
}));

const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([p, m]) => [
			p.replace(/^\.\.\//, '../../domains/'),
			m,
		])
	),
};

const POOL_IP = '203.0.113.7';
const MAIL_HOST = 'mail.owlat.test';
const GLOBAL_RETURN_PATH = 'bounces.owlat.test';

beforeEach(() => {
	registerDomainMock.mockReset();
	registerDomainMock.mockResolvedValue({ selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' });
	resolveTxtMock.mockReset();
	resolveMxMock.mockReset();
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	vi.stubEnv('MTA_API_URL', 'http://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('MTA_IP_POOLS', POOL_IP);
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', GLOBAL_RETURN_PATH);
	vi.stubEnv('EHLO_HOSTNAME', MAIL_HOST);
	vi.stubEnv('SPF_QUALIFIER', '~all');
	vi.stubEnv('MTA_SPF_INCLUDE', '');
	vi.stubEnv('MTA_TLSRPT_RUA', '');
	vi.stubEnv('MTA_DMARC_RUA', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

// ─── Finding 1 — atomic create carries the full bundle ────────────────────────

describe('Finding 1 — return-path host atomic with create', () => {
	it('create-with-host then register-completion lands DKIM/DMARC bundle + identity + custom mailFrom', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'acme.com',
			userId: 'user',
			returnPathHost: 'bounce.acme.com',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		// The row already carries the host BEFORE registration completes.
		await t.run(async (ctx) => {
			const d = await ctx.db.get(outcome.domainId);
			expect(d!.returnPathHost).toBe('bounce.acme.com');
			expect(d!.status).toBe('registering');
		});

		// Run register_with_provider AFTER the row + its return-path host exist —
		// the exact ordering the review flagged (registration completing after the
		// return-path is set). Driven explicitly for deterministic ordering.
		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId: outcome.domainId,
		});

		await t.run(async (ctx) => {
			const d = await ctx.db.get(outcome.domainId);
			// A real registering → pending edge, NOT a dropped self-loop.
			expect(d!.status).toBe('pending');
			const records = d!.dnsRecords as {
				dkim?: unknown[];
				dmarc?: unknown;
				mailFrom?: Array<{ type: string; hostname?: string; priority?: number }>;
			};
			// Full provider bundle present.
			expect(records.dkim).toBeDefined();
			expect(records.dkim!.length).toBeGreaterThan(0);
			expect(records.dmarc).toBeDefined();
			// Custom mailFrom on the override host — MX + SPF TXT.
			const hosts = records.mailFrom!.map((r) => `${r.type}:${r.hostname}`);
			expect(hosts).toContain('MX:bounce.acme.com');
			expect(hosts).toContain('TXT:bounce.acme.com');

			// Provider identity sibling row persisted (only written on a non-self-loop
			// register-completion — its presence proves the self-loop bug is gone).
			const identity = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', outcome.domainId))
				.first();
			expect(identity).not.toBeNull();
			expect(identity!.dkimSelector).toBe('s1');
		});
	});

	it('rejects an invalid return-path host at create (no half-created domain)', async () => {
		const t = convexTest(schema, modules);
		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'acme.com',
			userId: 'user',
			returnPathHost: 'localhost', // single label — rejected by the shared validator
		});
		expect(outcome).toEqual({ ok: false, reason: 'invalid_return_path_host' });
		await t.run(async (ctx) => {
			const rows = await ctx.db.query('domains').collect();
			expect(rows).toHaveLength(0); // nothing created
		});
	});
});

// ─── Finding 1 (edit path) — a return-path edit that RACES a registration ─────

describe('Finding 1 (edit path) — setReturnPathHost during registration keeps the bundle', () => {
	it('storing a host while registering does NOT self-loop away the DKIM/DMARC bundle', async () => {
		const t = convexTest(schema, modules);

		// A domain mid-registration (create, or `regenerateDnsRecords` put it back to
		// `registering`) with NO host yet.
		const domainId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'acme.com',
				status: 'registering',
				providerType: 'mta',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
		});

		// Edit the return-path host WHILE registering. The guard must store the host
		// only — no `status: 'pending'` patch, no record regen, no reflection — so the
		// pending register-completion below stays a real `registering → pending` edge
		// (not the `pending → pending` self-loop that `reduceSelfLoop` strips).
		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toMatchObject({ ok: true, changed: true });

		await t.run(async (ctx) => {
			const d = await ctx.db.get(domainId);
			expect(d!.returnPathHost).toBe('bounce.acme.com'); // host leads
			expect(d!.status).toBe('registering'); // status untouched — no premature pending
			expect(d!.dnsRecords).toEqual({}); // no records regenerated mid-registration
		});

		// Registration completes AFTER the edit — the exact ordering the review's
		// repro used to drop the bundle.
		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId,
		});

		await t.run(async (ctx) => {
			const d = await ctx.db.get(domainId);
			expect(d!.status).toBe('pending');
			const records = d!.dnsRecords as {
				dkim?: unknown[];
				dmarc?: unknown;
				mailFrom?: Array<{ type: string; hostname?: string }>;
			};
			// Full provider bundle survived — the residual edit-path self-loop is gone.
			expect(records.dkim?.length).toBeGreaterThan(0);
			expect(records.dmarc).toBeDefined();
			const hosts = records.mailFrom!.map((r) => `${r.type}:${r.hostname}`);
			expect(hosts).toContain('MX:bounce.acme.com');
			expect(hosts).toContain('TXT:bounce.acme.com');
			// Provider identity sibling persisted (only written on a non-self-loop).
			const identity = await ctx.db
				.query('sendingDomainMtaIdentities')
				.withIndex('by_domain', (q) => q.eq('domainId', domainId))
				.first();
			expect(identity).not.toBeNull();
		});
	});
});

// ─── Finding 2 — MTA return-path bundle has an MX ─────────────────────────────

describe('Finding 2 — bounce host MX for DSN routing', () => {
	it('buildReturnPathMailFromRecords emits BOTH the SPF TXT and the MX (target/priority)', () => {
		const records = buildReturnPathMailFromRecords('bounce.acme.com', [POOL_IP], '~all', MAIL_HOST);
		expect(records).toEqual([
			{
				type: 'MX',
				hostname: 'bounce.acme.com',
				value: MAIL_HOST,
				priority: RETURN_PATH_MX_PRIORITY,
			},
			{ type: 'TXT', hostname: 'bounce.acme.com', value: `v=spf1 ip4:${POOL_IP} ~all` },
		]);
		expect(RETURN_PATH_MX_PRIORITY).toBe(10);
	});

	it('omits the MX when no mail host is available (still emits the SPF TXT)', () => {
		const records = buildReturnPathMailFromRecords('bounce.acme.com', [POOL_IP], '~all', undefined);
		expect(records).toEqual([
			{ type: 'TXT', hostname: 'bounce.acme.com', value: `v=spf1 ip4:${POOL_IP} ~all` },
		]);
	});

	it('does NOT add an MX for the GLOBAL return-path domain (no regression on existing MTA domains)', async () => {
		// The MX is scoped to CUSTOM per-domain hosts. Emitting it for the global
		// MTA_RETURN_PATH_DOMAIN would newly FAIL every existing verified MTA domain
		// (which never had to publish that MX) the next time it regenerates. So a
		// domain on the global host regenerates to an SPF-TXT-only mailFrom bundle.
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'acme.com',
				status: 'registering',
				providerType: 'mta',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId,
		});

		await t.run(async (ctx) => {
			const d = await ctx.db.get(domainId);
			const mailFrom = (d!.dnsRecords as { mailFrom?: Array<{ type: string; hostname?: string }> })
				.mailFrom;
			// The global return-path SPF TXT is published…
			expect(mailFrom?.some((r) => r.type === 'TXT' && r.hostname === GLOBAL_RETURN_PATH)).toBe(true);
			// …but NO MX is emitted for the global host.
			expect(mailFrom?.some((r) => r.type === 'MX')).toBe(false);
		});
	});

	it('verifyDomain resolves BOTH the MX and the SPF TXT at the custom host', async () => {
		const t = convexTest(schema, modules);
		const spf = `v=spf1 ip4:${POOL_IP} ~all`;
		const domainId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'acme.com',
				status: 'pending',
				providerType: 'mta',
				returnPathHost: 'bounce.acme.com',
				dnsRecords: {
					mailFrom: [
						{ type: 'MX', hostname: 'bounce.acme.com', value: MAIL_HOST, priority: 10 },
						{ type: 'TXT', hostname: 'bounce.acme.com', value: spf },
					],
				},
				createdAt: now,
				updatedAt: now,
			});
		});

		resolveMxMock.mockResolvedValue([{ exchange: MAIL_HOST, priority: 10 }]);
		resolveTxtMock.mockResolvedValue([[spf]]);

		const res = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });

		expect(resolveMxMock).toHaveBeenCalledWith('bounce.acme.com');
		expect(resolveTxtMock).toHaveBeenCalledWith('bounce.acme.com');
		expect(res.results.mailFrom?.[0]?.verified).toBe(true); // MX
		expect(res.results.mailFrom?.[1]?.verified).toBe(true); // SPF TXT
	});
});

// ─── Finding 3 — Convex boundary rejects lax hosts ────────────────────────────

describe('Finding 3 — strict shared validator at the Convex boundary', () => {
	async function seedVerifiedMta(t: ReturnType<typeof convexTest>): Promise<Id<'domains'>> {
		return await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'acme.com',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	it.each(['localhost', '_bounce.acme.com'])(
		'rejects "%s" (asDnsName accepted it; the MTA rejects it forever)',
		async (host) => {
			const t = convexTest(schema, modules);
			const domainId = await seedVerifiedMta(t);
			await expect(
				t.mutation(api.domains.returnPath.setReturnPathHost, { domainId, returnPathHost: host })
			).rejects.toThrow(/Invalid return-path host/i);
			await t.run(async (ctx) => {
				const d = await ctx.db.get(domainId);
				expect(d!.returnPathHost).toBeUndefined();
				expect(d!.status).toBe('verified');
			});
		}
	);

	it('accepts a normal bounce.example.com', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedMta(t);
		await t.mutation(api.domains.returnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
		});
		await t.run(async (ctx) => {
			const d = await ctx.db.get(domainId);
			expect(d!.returnPathHost).toBe('bounce.acme.com');
		});
	});
});

// ─── Finding 4 — out-of-order reflection converges on the last host ───────────

describe('Finding 4 — out-of-order reflection convergence', () => {
	it('requeues for the CURRENT host when the host changed mid-reflection', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert('domains', {
				domain: 'acme.com',
				status: 'pending',
				providerType: 'mta',
				returnPathHost: 'bounce.old.com',
				dnsRecords: {},
				createdAt: now,
				updatedAt: now,
			});
		});

		// Simulate a concurrent edit committing WHILE the MTA reflection is in
		// flight: the perform call flips the domain's host to a newer value, so the
		// post-call re-read sees a superseded host.
		registerDomainMock.mockImplementation(async () => {
			await t.run(async (ctx) => {
				await ctx.db.patch(domainId, { returnPathHost: 'bounce.new.com' });
			});
			return { selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' };
		});

		await t.action(internal.domains.providers.registerAction.pushReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.old.com',
			attempt: 0,
		});

		// The reflection detected the change and requeued a fresh chain for the
		// CURRENT host so the provider converges to the last edit (not stuck on old).
		const requeued = await t.run(async (ctx) => {
			const jobs = await ctx.db.system.query('_scheduled_functions').collect();
			return jobs.filter((j) => j.name.includes('pushReturnPathHost'));
		});
		expect(requeued).toHaveLength(1);
		expect(requeued[0]!.args[0]).toMatchObject({ returnPathHost: 'bounce.new.com' });

		// The stale host's success path did NOT clear/set a marker for old.
		await t.run(async (ctx) => {
			const d = await ctx.db.get(domainId);
			expect(d!.returnPathHost).toBe('bounce.new.com');
			expect(d!.returnPathHostSyncError).toBeUndefined();
		});
	});
});
