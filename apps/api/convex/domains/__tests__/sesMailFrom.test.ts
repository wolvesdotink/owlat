/**
 * SES custom MAIL FROM parity — X1.
 *
 * D2 wired a per-domain `returnPathHost` through the built-in MTA and rejected
 * SES-backed domains with `unsupported_provider`. X1 lifts that: a return-path
 * host on an SES domain configures SES's custom MAIL FROM (a subdomain of the
 * sending domain) + the MX/SPF-TXT records SES requires, so provider choice does
 * not change the feature set. This gate locks:
 *
 *   1. Registration default vs override — `sesProvider.registerDomain` sets the
 *      SES custom MAIL FROM (default `mail.<domain>`, or the override) and emits
 *      the correct MX + SPF TXT records; a non-subdomain override is rejected.
 *   2. The pure host/record helpers (`resolveSesMailFrom`/`buildSesMailFromRecords`).
 *   3. Record regeneration on edit — the lifecycle `setReturnPathHost` no longer
 *      returns `unsupported_provider` for SES; it regenerates the SES MAIL FROM
 *      records on the new host, drops to `pending`, schedules the SES reflection,
 *      and rejects a non-subdomain host (`host_not_subdomain`).
 *   4. The `reflectSesMailFrom` action — success calls SES + clears the marker;
 *      failure paths (retry, give-up, non-SES guard).
 *   5. The public mutation accepts an SES domain (admin) and surfaces the
 *      subdomain constraint.
 *
 * Only the session helpers and the SES identity-manager factory are stubbed.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') {
				throwForbidden();
			}
			return ctx();
		}),
	};
});

const SES_REGION = 'us-east-1';
const setupMailFromMock = vi.fn();
const sesRegisterMock = vi.fn();
vi.mock('../../lib/emailProviders/sesIdentity', async (importActual) => {
	const actual = await importActual<typeof import('../../lib/emailProviders/sesIdentity')>();
	return {
		...actual,
		createSESIdentityManager: () => ({
			registerDomain: sesRegisterMock,
			setupMailFromDomain: setupMailFromMock,
			getRegion: () => SES_REGION,
			getVerificationStatus: vi.fn().mockResolvedValue({
				verificationStatus: 'Success',
				dkimStatus: 'Success',
				dkimTokens: [],
			}),
			deleteIdentity: vi.fn(),
		}),
	};
});

const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const modules = { ...rootGlob, ...domainsGlob };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a minimal SES-provider domain row (default `mail.<domain>` MAIL FROM). */
async function seedSesDomain(
	t: ReturnType<typeof convexTest>,
	overrides: Record<string, unknown> = {}
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('domains', {
			domain: 'acme.com',
			status: 'verified',
			providerType: 'ses',
			dnsRecords: {
				dkim: [{ type: 'CNAME', host: 't1._domainkey', value: 't1.dkim.amazonses.com' }],
				mailFrom: [
					{
						type: 'MX',
						host: 'mail',
						value: `feedback-smtp.${SES_REGION}.amazonses.com`,
						priority: 10,
					},
					{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
				],
			},
			verificationResults: {
				dkim: [{ verified: true, lastChecked: now }],
				mailFrom: [
					{ verified: true, lastChecked: now },
					{ verified: true, lastChecked: now },
				],
			},
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

async function scheduledReflections(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs.filter((j) => j.name.includes('reflectSesMailFrom'));
	});
}

beforeEach(() => {
	mockRole = 'admin';
	setupMailFromMock.mockReset();
	setupMailFromMock.mockResolvedValue(undefined);
	sesRegisterMock.mockReset();
	sesRegisterMock.mockResolvedValue({ verificationToken: 'vtok', dkimTokens: ['t1', 't2', 't3'] });
	vi.stubEnv('AWS_SES_REGION', SES_REGION);
	vi.stubEnv('MTA_DMARC_RUA', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

// ─── 1. Registration: default vs override ─────────────────────────────────────

describe('sesProvider.registerDomain — custom MAIL FROM', () => {
	it('defaults to mail.<domain> when no returnPathHost is set (unchanged behavior)', async () => {
		const { sesProvider } = await import('../providers/ses/index');
		const result = await sesProvider.registerDomain('acme.com');

		expect(setupMailFromMock).toHaveBeenCalledWith('acme.com', 'mail');
		const mailFrom = result.dnsRecords.mailFrom!;
		expect(mailFrom).toEqual([
			{
				type: 'MX',
				host: 'mail',
				value: `feedback-smtp.${SES_REGION}.amazonses.com`,
				priority: 10,
			},
			{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
		]);
	});

	it('uses the returnPathHost override as the SES MAIL FROM subdomain + records', async () => {
		const { sesProvider } = await import('../providers/ses/index');
		const result = await sesProvider.registerDomain('acme.com', {
			returnPathHost: 'bounce.acme.com',
		});

		// SES configured with the sub-label of the override.
		expect(setupMailFromMock).toHaveBeenCalledWith('acme.com', 'bounce');
		const mailFrom = result.dnsRecords.mailFrom!;
		expect(mailFrom).toEqual([
			{
				type: 'MX',
				host: 'bounce',
				value: `feedback-smtp.${SES_REGION}.amazonses.com`,
				priority: 10,
			},
			{ type: 'TXT', host: 'bounce', value: 'v=spf1 include:amazonses.com ~all' },
		]);
	});

	it('rejects a returnPathHost that is not a subdomain of the sending domain', async () => {
		const { sesProvider } = await import('../providers/ses/index');
		await expect(
			sesProvider.registerDomain('acme.com', { returnPathHost: 'bounces.owlat.com' })
		).rejects.toThrow(/must be a subdomain of acme\.com/i);
		expect(setupMailFromMock).not.toHaveBeenCalled();
	});
});

// ─── 2. Pure helpers ──────────────────────────────────────────────────────────

describe('resolveSesMailFrom / buildSesMailFromRecords', () => {
	it('resolves the default mail label when no override is given', async () => {
		const { resolveSesMailFrom } = await import('../providers/ses/mailFrom');
		expect(resolveSesMailFrom('acme.com')).toEqual({
			host: 'mail',
			mailFromDomain: 'mail.acme.com',
		});
	});

	it('resolves a subdomain override to its relative label', async () => {
		const { resolveSesMailFrom } = await import('../providers/ses/mailFrom');
		expect(resolveSesMailFrom('acme.com', 'bounce.acme.com')).toEqual({
			host: 'bounce',
			mailFromDomain: 'bounce.acme.com',
		});
		// Multi-label sub is preserved.
		expect(resolveSesMailFrom('acme.com', 'a.b.acme.com')).toEqual({
			host: 'a.b',
			mailFromDomain: 'a.b.acme.com',
		});
	});

	it('rejects the apex and out-of-zone hosts', async () => {
		const { resolveSesMailFrom } = await import('../providers/ses/mailFrom');
		expect(resolveSesMailFrom('acme.com', 'acme.com')).toBeNull();
		expect(resolveSesMailFrom('acme.com', 'bounces.owlat.com')).toBeNull();
		expect(resolveSesMailFrom('acme.com', 'notacme.com')).toBeNull();
	});

	it('builds the SES MX + SPF TXT record pair at a host', async () => {
		const { buildSesMailFromRecords } = await import('../providers/ses/mailFrom');
		expect(buildSesMailFromRecords('bounce', SES_REGION)).toEqual([
			{
				type: 'MX',
				host: 'bounce',
				value: `feedback-smtp.${SES_REGION}.amazonses.com`,
				priority: 10,
			},
			{ type: 'TXT', host: 'bounce', value: 'v=spf1 include:amazonses.com ~all' },
		]);
	});
});

// ─── 3. Lifecycle edit — SES is now supported ─────────────────────────────────

describe('lifecycle.setReturnPathHost — SES', () => {
	it('no longer returns unsupported_provider; regenerates SES records, pending, schedules reflection', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t);

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: true, returnPathHost: 'bounce.acme.com', changed: true });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBe('bounce.acme.com');
			expect(domain!.status).toBe('pending');
			const mailFrom = (domain!.dnsRecords as { mailFrom?: Array<{ type: string; host: string }> })
				.mailFrom!;
			expect(mailFrom).toEqual([
				{
					type: 'MX',
					host: 'bounce',
					value: `feedback-smtp.${SES_REGION}.amazonses.com`,
					priority: 10,
				},
				{ type: 'TXT', host: 'bounce', value: 'v=spf1 include:amazonses.com ~all' },
			]);
			// Stale MAIL FROM verification dropped.
			const vr = domain!.verificationResults as { mailFrom?: unknown };
			expect(vr.mailFrom).toBeUndefined();

			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toContain('sending_domain.return_path_changed');
		});

		const reflections = await scheduledReflections(t);
		expect(reflections).toHaveLength(1);
		expect(reflections[0]!.args[0]).toMatchObject({ returnPathHost: 'bounce.acme.com' });
	});

	it('rejects a non-subdomain host for SES (host_not_subdomain), writing nothing', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t);

		const outcome = await t.mutation(internal.domains.lifecycle.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounces.owlat.com',
			userId: 'user',
		});
		expect(outcome).toEqual({ ok: false, reason: 'host_not_subdomain' });

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBeUndefined();
			expect(domain!.status).toBe('verified');
		});
		expect(await scheduledReflections(t)).toHaveLength(0);
	});
});

// ─── 4. reflectSesMailFrom action ─────────────────────────────────────────────

describe('reflectSesMailFrom — SES reflection with bounded retry', () => {
	it('calls SES setupMailFromDomain and clears a prior sync-failure marker', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t, {
			returnPathHost: 'bounce.acme.com',
			returnPathHostSyncError: 'previous failure',
		});

		await t.action(internal.domains.providers.registerAction.reflectSesMailFrom, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			attempt: 0,
		});

		expect(setupMailFromMock).toHaveBeenCalledWith('acme.com', 'bounce');
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHostSyncError).toBeUndefined();
		});
	});

	it('reschedules on a transient SES failure', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t, { returnPathHost: 'bounce.acme.com' });
		setupMailFromMock.mockRejectedValue(new Error('SES throttled'));

		await t.action(internal.domains.providers.registerAction.reflectSesMailFrom, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			attempt: 0,
		});

		const reflections = await scheduledReflections(t);
		expect(reflections).toHaveLength(1);
		expect(reflections[0]!.args[0]).toMatchObject({
			returnPathHost: 'bounce.acme.com',
			attempt: 1,
		});
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHostSyncError).toBeUndefined();
		});
	});

	it('sets the sync-failure marker + audits the give-up on the final attempt', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t, { returnPathHost: 'bounce.acme.com' });
		setupMailFromMock.mockRejectedValue(new Error('SES down'));

		await t.action(internal.domains.providers.registerAction.reflectSesMailFrom, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			attempt: 4,
		});

		expect(await scheduledReflections(t)).toHaveLength(0);
		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHostSyncError).toContain('SES down');
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			const giveUp = audits.find(
				(a) =>
					a.action === 'sending_domain.return_path_changed' &&
					a.details?.['applied'] === 'sync_failed'
			);
			expect(giveUp).toBeDefined();
		});
	});

	it('skips a non-SES (MTA) domain', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t, {
			providerType: 'mta',
			returnPathHost: 'bounce.acme.com',
		});

		await t.action(internal.domains.providers.registerAction.reflectSesMailFrom, {
			domainId,
			returnPathHost: 'bounce.acme.com',
			attempt: 0,
		});

		expect(setupMailFromMock).not.toHaveBeenCalled();
	});
});

// ─── 5. Public mutation ──────────────────────────────────────────────────────

describe('returnPath.setReturnPathHost — SES via the public mutation', () => {
	it('lets an admin set a subdomain host on an SES domain (no unsupported_provider)', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t);
		mockRole = 'admin';

		await t.mutation(api.domains.returnPath.setReturnPathHost, {
			domainId,
			returnPathHost: 'bounce.acme.com',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.returnPathHost).toBe('bounce.acme.com');
			expect(domain!.status).toBe('pending');
		});
	});

	it('surfaces the SES subdomain constraint as an invalid-input error', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t);
		mockRole = 'owner';

		await expect(
			t.mutation(api.domains.returnPath.setReturnPathHost, {
				domainId,
				returnPathHost: 'bounces.owlat.com',
			})
		).rejects.toThrow(/subdomain of the sending domain/i);
	});

	it('rejects a non-admin (editor)', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedSesDomain(t);
		mockRole = 'editor';

		await expect(
			t.mutation(api.domains.returnPath.setReturnPathHost, {
				domainId,
				returnPathHost: 'bounce.acme.com',
			})
		).rejects.toThrow(/permission/i);
	});
});
