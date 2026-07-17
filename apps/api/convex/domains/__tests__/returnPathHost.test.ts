/**
 * Per-domain VERP return-path host — Convex side (D2).
 *
 * The D1 MTA API added an optional `returnPathHost` to `/dkim/{domain}/register`
 * (tri-state: absent = no change, string = set, null = clear). D2 wires the
 * Convex backend to it end to end. This gate locks:
 *
 *   1. Registration default vs override — the MTA HTTP client sends the correct
 *      tri-state body, and `mtaProvider.registerDomain` builds the `mailFrom`
 *      SPF record on the override host (falling back to the global env when
 *      absent) AND reflects the host to the MTA.
 *   2. Record regeneration on edit — the lifecycle `setReturnPathHost`
 *      regenerates the `mailFrom` record on the new host, drops the domain to
 *      `pending`, clears the stale MAIL FROM verification result, schedules the
 *      MTA push, and audits the change. No-op / unsupported-provider / invalid
 *      host are handled.
 *   3. Verification lookups target the custom host — `verifyDomain` resolves the
 *      `mailFrom` record's absolute `hostname` (the override), not a From-domain
 *      subhost.
 *   4. Authz on the public edit mutation — admin-gated (`organization:manage`);
 *      a non-admin (editor) is rejected and nothing is written.
 *
 * convex-test drives the real lifecycle + public mutation over an in-memory DB;
 * only the session helpers, the MTA HTTP client factory, and `node:dns/promises`
 * are stubbed (creds / network seams). The real `MtaIdentityManager` class is
 * kept for the tri-state client test.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mutable role each authz test selects.
let mockRole: OrganizationRole = 'admin';

function throwForbidden(): never {
	const err = new Error("You don't have permission to perform this action") as Error & {
		data?: { category: string };
	};
	err.data = { category: 'forbidden' };
	throw err;
}

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const ctx = () => ({ userId: 'test-user', role: mockRole });
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
		// Role-aware gate: owner/admin pass `organization:manage`, editor does not.
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
});

// Stub ONLY the identity-manager factory (the MTA HTTP client), keeping the real
// `MtaIdentityManager` class so the tri-state fetch test exercises the actual
// request construction.
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

// Stub DNS so the verification test can assert the exact hostname resolved.
const resolveTxtMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	default: {
		resolveTxt: (host: string) => resolveTxtMock(host),
		resolveCname: vi.fn().mockRejectedValue(new Error('no cname')),
		resolveMx: vi.fn().mockRejectedValue(new Error('no mx')),
		resolve: vi.fn().mockRejectedValue(new Error('no record')),
		resolve4: vi.fn().mockRejectedValue(new Error('no a')),
		reverse: vi.fn().mockRejectedValue(new Error('no ptr')),
	},
}));

// Vite's `import.meta.glob` omits the directory chain it climbed to reach the
// base, so `'../../**'` from `domains/__tests__` skips the sibling `domains/*`
// modules under test. Merge a `domains/`-rooted glob, re-prefixed to the same
// form, so convex-test resolves every module. Exclude the 'use node' register
// action (needs MTA creds); we assert its scheduling via `_scheduled_functions`.
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...domainsGlob }).filter(
		([path]) => !path.includes('providers/registerAction')
	)
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GLOBAL_RETURN_PATH = 'bounces.owlat.com';
const POOL_IP = '203.0.113.7';

/** Insert a minimal MTA-provider domain row. */
async function seedMtaDomain(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('domains', {
			domain: 'acme.com',
			status: 'verified',
			providerType: 'mta',
			dnsRecords: {
				dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; k=rsa; p=KEY' }],
				mailFrom: [
					{ type: 'TXT', hostname: GLOBAL_RETURN_PATH, value: `v=spf1 ip4:${POOL_IP} ~all` },
				],
			},
			verificationResults: {
				dkim: [{ verified: true, lastChecked: now }],
				mailFrom: [{ verified: true, lastChecked: now }],
			},
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

beforeEach(() => {
	mockRole = 'admin';
	registerDomainMock.mockReset();
	registerDomainMock.mockResolvedValue({ selector: 's1', dnsRecord: 'v=DKIM1; k=rsa; p=KEY' });
	resolveTxtMock.mockReset();
	vi.stubEnv('MTA_API_URL', 'http://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('MTA_IP_POOLS', POOL_IP);
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', GLOBAL_RETURN_PATH);
	vi.stubEnv('SPF_QUALIFIER', '~all');
	// Keep the DKIM/DMARC/SPF-include/TLS-RPT records deterministic.
	vi.stubEnv('MTA_SPF_INCLUDE', '');
	vi.stubEnv('MTA_TLSRPT_RUA', '');
	vi.stubEnv('MTA_DMARC_RUA', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

// ─── 1. Registration: default vs override ─────────────────────────────────────

describe('MTA HTTP client — returnPathHost tri-state body (D1 contract)', () => {
	async function captureRequest(
		call: (m: import('../../lib/emailProviders/mtaIdentity').MtaIdentityManager) => Promise<unknown>
	): Promise<RequestInit> {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					domain: 'acme.com',
					selector: 's1',
					dnsRecord: 'v=DKIM1; p=K',
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}
			)
		);
		vi.stubGlobal('fetch', fetchMock);
		const { MtaIdentityManager } = await import('../../lib/emailProviders/mtaIdentity');
		await call(new MtaIdentityManager({ baseUrl: 'http://mta.test', apiKey: 'k' }));
		return fetchMock.mock.calls[0]![1] as RequestInit;
	}

	it('sends NO body when returnPathHost is absent (historic call, MTA keeps global)', async () => {
		const init = await captureRequest((m) => m.registerDomain('acme.com'));
		expect(init.body).toBeUndefined();
	});

	it('sends the host when returnPathHost is a string (set)', async () => {
		const init = await captureRequest((m) => m.registerDomain('acme.com', 'bounce.acme.com'));
		expect(JSON.parse(init.body as string)).toEqual({ returnPathHost: 'bounce.acme.com' });
	});

	it('sends null when returnPathHost is null (clear)', async () => {
		const init = await captureRequest((m) => m.registerDomain('acme.com', null));
		expect(JSON.parse(init.body as string)).toEqual({ returnPathHost: null });
	});
});

describe('mtaProvider.registerDomain — mailFrom host from returnPathHost', () => {
	it('builds the mailFrom record on the GLOBAL env host when no override is given', async () => {
		const { mtaProvider } = await import('../providers/mta/index');
		const result = await mtaProvider.registerDomain('acme.com');

		expect(result.dnsRecords.mailFrom).toHaveLength(1);
		expect(result.dnsRecords.mailFrom![0]!.hostname).toBe(GLOBAL_RETURN_PATH);
		expect(result.dnsRecords.mailFrom![0]!.value).toContain(`ip4:${POOL_IP}`);
		// No custom host → the MTA is told nothing (keeps its global).
		expect(registerDomainMock).toHaveBeenCalledWith('acme.com', undefined);
	});

	it('builds the mailFrom record on the OVERRIDE host and reflects it to the MTA', async () => {
		const { mtaProvider } = await import('../providers/mta/index');
		const result = await mtaProvider.registerDomain('acme.com', {
			returnPathHost: 'bounce.acme.com',
		});

		expect(result.dnsRecords.mailFrom![0]!.hostname).toBe('bounce.acme.com');
		expect(result.dnsRecords.mailFrom![0]!.value).toContain(`ip4:${POOL_IP}`);
		expect(registerDomainMock).toHaveBeenCalledWith('acme.com', 'bounce.acme.com');
	});
});

// ─── 2. Record regeneration on edit ───────────────────────────────────────────

describe('lifecycle.setReturnPathHost — record regeneration + status', () => {
	it('regenerates mailFrom on the new host, drops to pending, clears verification, schedules the MTA push, audits', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t);

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'Bounce.ACME.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: true, returnPathHost: 'bounce.acme.com', changed: true });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBe('bounce.acme.com');
			expect(domain!.status).toBe('pending');
			// mailFrom regenerated on the new host, still authorizing the pool IPs.
			const mailFrom = (
				domain!.dnsRecords as { mailFrom?: Array<{ hostname?: string; value: string }> }
			).mailFrom!;
			expect(mailFrom[0]!.hostname).toBe('bounce.acme.com');
			expect(mailFrom[0]!.value).toContain(`ip4:${POOL_IP}`);
			// Stale MAIL FROM verification result dropped; DKIM result preserved.
			const vr = domain!.verificationResults as { mailFrom?: unknown; dkim?: unknown };
			expect(vr.mailFrom).toBeUndefined();
			expect(vr.dkim).toBeDefined();

			// Audit row fired.
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.return_path_changed');

			// The MTA push was scheduled with the normalized host.
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			const push = scheduled.filter((s) => s.name.includes('pushReturnPathHost'));
			expect(push).toHaveLength(1);
			expect(push[0]!.args[0]).toMatchObject({ returnPathHost: 'bounce.acme.com' });
		});
	});

	it('is a no-op when the host is unchanged (no status change, no push)', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t, { returnPathHost: 'bounce.acme.com' });

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: true, returnPathHost: 'bounce.acme.com', changed: false });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.status).toBe('verified'); // untouched
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.filter((s) => s.name.includes('pushReturnPathHost'))).toHaveLength(0);
		});
	});

	it('rejects a non-MTA (SES) domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t, { providerType: 'ses' });

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'unsupported_provider' });
	});

	it('rejects an invalid hostname', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t);

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'not a host; rm -rf /',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'invalid_host' });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBeUndefined();
			expect(domain!.status).toBe('verified'); // untouched
		});
	});

	it('returns domain_not_found for a missing domain', async () => {
		const t = convexTest(schema, modules);
		const ghost = await seedMtaDomain(t);
		await t.run(async (ctx) => {
			await ctx.db.delete(ghost);
		});

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId: ghost,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'domain_not_found' });
	});
});

// ─── 3. Verification lookups target the custom host ───────────────────────────

describe('verifyDomain — resolves the mailFrom record on its absolute custom host', () => {
	it('looks up the override return-path host, not a From-domain subhost', async () => {
		const t = convexTest(schema, modules);
		const spfValue = `v=spf1 ip4:${POOL_IP} ~all`;
		// A domain whose only record is a mailFrom SPF on the custom host.
		const domainId = await seedMtaDomain(t, {
			status: 'pending',
			returnPathHost: 'bounce.acme.com',
			dnsRecords: {
				mailFrom: [{ type: 'TXT', hostname: 'bounce.acme.com', value: spfValue }],
			},
			verificationResults: undefined,
		});

		resolveTxtMock.mockResolvedValue([[spfValue]]);

		const res = await t.action(api.domains.dnsVerification.verifyDomain, { domainId });

		// The resolver was asked for the custom host verbatim (an absolute FQDN),
		// never `bounce.acme.com.acme.com`.
		expect(resolveTxtMock).toHaveBeenCalledWith('bounce.acme.com');
		expect(res.results.mailFrom?.[0]?.verified).toBe(true);
	});
});

// ─── 4. Authz on the public edit mutation ─────────────────────────────────────

describe('domains.setReturnPathHost — authorization', () => {
	it('rejects a non-admin member (editor) and writes nothing', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t);
		mockRole = 'editor';

		await expect(
			t.mutation(api.domains.domains.setReturnPathHost, {
				domainId,
				returnPathHost: 'bounce.acme.com',
			})
		).rejects.toThrow(/permission/i);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBeUndefined();
			expect(domain!.status).toBe('verified');
		});
	});

	it('lets an admin set the host', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t);
		mockRole = 'admin';

		await t.mutation(api.domains.domains.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBe('bounce.acme.com');
			expect(domain!.status).toBe('pending');
		});
	});

	it('rejects an invalid hostname with an invalid-input error', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedMtaDomain(t);
		mockRole = 'owner';

		await expect(
			t.mutation(api.domains.domains.setReturnPathHost, {
				domainId,
				returnPathHost: 'nope; drop table',
			})
		).rejects.toThrow(/Invalid return-path host/i);
	});
});
