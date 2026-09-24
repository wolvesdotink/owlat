/**
 * Send-only sending domains — "Owlat sends for this domain, my existing
 * provider keeps receiving it".
 *
 * Three surfaces, one rule each:
 *   1. `mtaProvider.registerDomain` — an external-receiving domain's apex SPF
 *      authorizes BOTH senders and its `_smtp._tls` record is omitted; an
 *      `owlat` (or absent) mode generates byte-identically to before the feature.
 *   2. `lifecycle.create` — the mode is stored ATOMICALLY with the insert, so
 *      the registration this same mutation schedules reads the right arrangement.
 *   3. `lifecycle.setReceivingMode` — surgical regeneration of exactly the two
 *      records the mode owns, its own audit action, and a drop back to `pending`
 *      only when a published record actually moved.
 *
 * The invariant running through all of them: ABSENCE IS `'owlat'`. A row written
 * before this feature has no mode and must behave exactly as it did.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { OrganizationRole } from '../../lib/sessionOrganization';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';

// The flow under test schedules the functions below, which this suite's
// module map leaves out (or which need a setup it does not make). Their jobs
// fail when they fire, often after the test that scheduled them. These tests
// are not about them.
beforeEach(() => {
	expectScheduledFailure('domains/providers/registerAction:run');
	expectScheduledFailure('domains/providers/registerAction:deleteDomainAction');
});

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
		requireOrgPermission: vi.fn(async (_c: unknown, permission: string) => {
			if (permission === 'organization:manage' && mockRole === 'editor') throwForbidden();
			return ctx();
		}),
	};
});

// The MTA identity manager would talk to the MTA over HTTP; the adapter only
// needs a selector + DKIM record back to assemble the bundle under test.
vi.mock('../../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: vi
			.fn()
			.mockResolvedValue({ selector: 'owlat', dnsRecord: 'v=DKIM1; k=rsa; p=AAA' }),
		deleteDomain: vi.fn().mockResolvedValue(undefined),
	}),
}));

// SES talks to AWS; the adapter needs three answers to assemble its bundle. The
// relay arm matters here because SES builds its OWN apex SPF record, and that is
// the record the register action has to fold the receiver's include into.
const SES_REGION = 'us-east-1';
vi.mock('../../lib/emailProviders/sesIdentity', () => ({
	createSESIdentityManager: () => ({
		registerDomain: vi.fn().mockResolvedValue({ verificationToken: 'vtok', dkimTokens: ['t1'] }),
		setupMailFromDomain: vi.fn().mockResolvedValue(undefined),
		getRegion: () => SES_REGION,
		getVerificationStatus: vi.fn().mockResolvedValue({
			verificationStatus: 'Success',
			dkimStatus: 'Success',
			dkimTokens: ['t1'],
		}),
		deleteIdentity: vi.fn(),
	}),
}));

// Import after the mock is registered.
import { mtaProvider } from '../providers/mta';

// See `inboundMailConfig.test.ts`: a glob rooted at `../../` omits the
// `domains/` chain it climbed through, so the sibling modules under test are
// merged in from a second glob and re-prefixed.
const rootGlob = import.meta.glob('../../**/*.*s');
const domainsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../domains/'),
		mod,
	])
);
const allModules = { ...rootGlob, ...domainsGlob };
// `create` only SCHEDULES the registration, and the mutation tests never want it
// to run, so the default map omits the `'use node'` action. The registration
// tests below use `allModules` and drive it themselves.
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) => !path.includes('providers/registerAction'))
);

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const OUR_SPF = 'v=spf1 include:spf.owlat.example ~all';
const TLSRPT_VALUE = 'v=TLSRPTv1; rua=mailto:tls@owlat.example';

beforeEach(() => {
	mockRole = 'admin';
	vi.stubEnv('MTA_SPF_INCLUDE', 'spf.owlat.example');
	vi.stubEnv('MTA_TLSRPT_RUA', 'mailto:tls@owlat.example');
	vi.stubEnv('MTA_DMARC_RUA', '');
	vi.stubEnv('MTA_IP_POOLS', '');
	vi.stubEnv('MTA_RETURN_PATH_DOMAIN', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('mtaProvider.registerDomain — receiving mode', () => {
	it('generates today’s bundle when no receiving mode is supplied', async () => {
		const { dnsRecords } = await mtaProvider.registerDomain('acme.example');

		expect(dnsRecords.spf!.value).toBe(OUR_SPF);
		expect(dnsRecords.tlsRpt!.value).toBe(TLSRPT_VALUE);
	});

	it('is identical for an explicit owlat mode — absence and owlat are one case', async () => {
		const { dnsRecords } = await mtaProvider.registerDomain('acme.example', {
			receiving: { mode: 'owlat' },
		});

		expect(dnsRecords.spf!.value).toBe(OUR_SPF);
		expect(dnsRecords.tlsRpt!.value).toBe(TLSRPT_VALUE);
	});

	it('emits OUR sending hosts only — the receiver fold belongs to the register action', async () => {
		// The adapter describes the hosts WE send from, in both modes. Folding the
		// receiver's include here would make the fix provider-local, and SES and
		// Mandrill build their own apex record without ever reaching this file.
		const { dnsRecords } = await mtaProvider.registerDomain('acme.example', {
			receiving: { mode: 'external', provider: 'google' },
		});

		expect(dnsRecords.spf!.value).toBe(OUR_SPF);
		expect(dnsRecords.spf!.host).toBe('@');
	});

	it('omits the _smtp._tls record in send-only mode', async () => {
		// TLS-RPT solicits reports about INBOUND delivery, which for this domain
		// terminates at the other provider's MX, not at ours.
		const { dnsRecords } = await mtaProvider.registerDomain('acme.example', {
			receiving: { mode: 'external', provider: 'google' },
		});

		expect(dnsRecords.tlsRpt).toBeUndefined();
	});

	it('leaves DKIM and DMARC alone — both are about the mail we SEND', async () => {
		const { dnsRecords, identity: mtaIdentity } = await mtaProvider.registerDomain('acme.example', {
			receiving: { mode: 'external', provider: 'google' },
		});

		expect(dnsRecords.dkim).toHaveLength(1);
		expect(dnsRecords.dkim![0]!.host).toBe('owlat._domainkey');
		expect(dnsRecords.dmarc!.value).toBe('v=DMARC1; p=none');
		expect(mtaIdentity.dkimSelector).toBe('owlat');
	});
});

/**
 * Registration — the provider-agnostic seam.
 *
 * The bug this pins is the one the whole feature exists to prevent, and it is
 * invisible in the adapters: on an `EMAIL_PROVIDER=ses` deployment the panel
 * showed `v=spf1 include:amazonses.com -all` to an operator who had just said
 * "keep Google Workspace", and told them to publish it exactly as shown. So the
 * fold is asserted through `registerAction.run` for a RELAY primary as well as
 * for our own MTA, because that is the one path both of them take.
 */
async function seedRegisteringDomain(
	t: ReturnType<typeof convexTest>,
	domain: string,
	fields: Record<string, unknown> = {}
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			domain,
			status: 'registering',
			providerType: 'mta',
			dnsRecords: {},
			createdAt: 1,
			updatedAt: 1,
			...fields,
		})
	);
}

describe('registerAction.run — the external SPF fold, for every provider', () => {
	it('folds the receiver include into a RELAY provider’s apex record', async () => {
		const t = convexTest(schema, allModules);
		const domainId = await seedRegisteringDomain(t, 'relay.example', {
			providerType: 'ses',
			receivingMode: 'external',
			externalReceivingProvider: 'google',
		});

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'ses',
			domainId,
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// SES's own record, plus Google's include, in ONE record — and SES's
			// hard-fail qualifier survives, so nothing this domain sends is
			// downgraded by the merge.
			expect(domain!.dnsRecords.spf!.value).toBe(
				'v=spf1 include:amazonses.com include:_spf.google.com -all'
			);
		});
	});

	it('folds it for our own MTA too, from the same seam', async () => {
		const t = convexTest(schema, allModules);
		const domainId = await seedRegisteringDomain(t, 'own.example', {
			receivingMode: 'external',
			externalReceivingProvider: 'microsoft',
		});

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId,
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.spf!.value).toBe(
				'v=spf1 include:spf.owlat.example include:spf.protection.outlook.com ~all'
			);
			// The adapter's half of the mode is still applied.
			expect(domain!.dnsRecords.tlsRpt).toBeUndefined();
		});
	});

	it('leaves the adapter’s record alone for an unknown provider rather than guessing', async () => {
		const t = convexTest(schema, allModules);
		const domainId = await seedRegisteringDomain(t, 'unknown.example', {
			providerType: 'ses',
			receivingMode: 'external',
			externalReceivingProvider: 'other',
		});

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'ses',
			domainId,
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.spf!.value).toBe('v=spf1 include:amazonses.com -all');
		});
	});

	it('threads no receiving arrangement for a row that carries none', async () => {
		const t = convexTest(schema, allModules);
		const domainId = await seedRegisteringDomain(t, 'plain.example');

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId,
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// Byte-identical to a pre-feature registration: our include only, and the
			// TLS-RPT record still there.
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			expect(domain!.dnsRecords.tlsRpt!.value).toBe(TLSRPT_VALUE);
			expect(domain!.status).toBe('pending');
		});
	});

	it('threads the stored mode down to the adapter, not just to the fold', async () => {
		const t = convexTest(schema, allModules);
		const domainId = await seedRegisteringDomain(t, 'threaded.example', {
			receivingMode: 'external',
			externalReceivingProvider: 'other',
		});

		await t.action(internal.domains.providers.registerAction.run, {
			providerType: 'mta',
			domainId,
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// `'other'` has no include, so the SPF record cannot show the mode got
			// through. The dropped TLS-RPT record can: only the adapter drops it, and
			// only when it was handed `receiving.mode === 'external'`.
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			expect(domain!.dnsRecords.tlsRpt).toBeUndefined();
		});
	});
});

describe('lifecycle.create — receiving mode stored with the insert', () => {
	it('persists the mode and provider atomically so registration reads them', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'external.example',
			userId: 'user',
			receivingMode: 'external',
			externalReceivingProvider: 'google',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(outcome.domainId);
			expect(domain!.receivingMode).toBe('external');
			expect(domain!.externalReceivingProvider).toBe('google');
		});
	});

	it('leaves both fields ABSENT when no mode is supplied — no backfill, no default row', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'plain.example',
			userId: 'user',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(outcome.domainId);
			expect(domain!.receivingMode).toBeUndefined();
			expect(domain!.externalReceivingProvider).toBeUndefined();
		});
	});

	it('drops a provider supplied alongside owlat — it would be a stale answer', async () => {
		const t = convexTest(schema, modules);

		const outcome = await t.mutation(internal.domains.lifecycle.create, {
			domain: 'owlat.example',
			userId: 'user',
			receivingMode: 'owlat',
			externalReceivingProvider: 'google',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(outcome.domainId);
			expect(domain!.receivingMode).toBe('owlat');
			expect(domain!.externalReceivingProvider).toBeUndefined();
		});
	});
});

type SeedOverrides = {
	status?: 'registering' | 'pending' | 'verified' | 'failed';
	providerType?: string;
};

async function seedVerifiedDomain(
	t: ReturnType<typeof convexTest>,
	domain: string,
	overrides: SeedOverrides = {}
): Promise<Id<'domains'>> {
	const checked = { verified: true, lastChecked: 1 };
	return await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			domain,
			status: overrides.status ?? 'verified',
			providerType: overrides.providerType ?? 'mta',
			dnsRecords: {
				spf: { type: 'TXT', host: '@', value: OUR_SPF },
				dkim: [{ type: 'TXT', host: 'owlat._domainkey', value: 'v=DKIM1; p=AAA' }],
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				tlsRpt: { type: 'TXT', host: '_smtp._tls', value: TLSRPT_VALUE },
			},
			verificationResults: {
				spf: checked,
				dkim: [checked],
				dmarc: checked,
				tlsRpt: checked,
			},
			createdAt: 1,
			updatedAt: 1,
		})
	);
}

describe('lifecycle.setReceivingMode — owlat → external', () => {
	it('rebuilds the apex SPF, drops TLS-RPT, and returns the domain to pending', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'switch.example');

		const outcome = await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(true);
		expect(outcome.receivingMode).toBe('external');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.receivingMode).toBe('external');
			expect(domain!.externalReceivingProvider).toBe('google');
			expect(domain!.dnsRecords.spf!.value).toBe(
				'v=spf1 include:spf.owlat.example include:_spf.google.com ~all'
			);
			expect(domain!.dnsRecords.tlsRpt).toBeUndefined();
			// The operator has DNS to republish, so the domain is no longer verified.
			expect(domain!.status).toBe('pending');
			// Only the results for the records that moved are dropped.
			expect(domain!.verificationResults?.spf).toBeUndefined();
			expect(domain!.verificationResults?.tlsRpt).toBeUndefined();
			expect(domain!.verificationResults?.dmarc?.verified).toBe(true);
			expect(domain!.verificationResults?.dkim?.[0]?.verified).toBe(true);
			// DKIM/DMARC records themselves are untouched — sending-side, both.
			expect(domain!.dnsRecords.dmarc!.value).toBe('v=DMARC1; p=none');
			expect(domain!.dnsRecords.dkim).toHaveLength(1);
		});
	});

	it('audits under its own action, not as a verification failure', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'audited.example');

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'microsoft',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits.map((a) => a.action)).toEqual(['sending_domain.receiving_mode_changed']);
			expect(audits[0]!.details).toMatchObject({
				domain: 'audited.example',
				previousMode: 'owlat',
				newMode: 'external',
				previousProvider: null,
				newProvider: 'microsoft',
			});
		});
	});

	it('rebuilds from scratch, so switching provider replaces the old include', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'reswitch.example');

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});
		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'microsoft',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.spf!.value).toBe(
				'v=spf1 include:spf.owlat.example include:spf.protection.outlook.com ~all'
			);
			expect(domain!.dnsRecords.spf!.value).not.toContain('_spf.google.com');
		});
	});

	it('leaves the record unchanged for an unknown provider but still stores the mode', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'other.example');

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'other',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.externalReceivingProvider).toBe('other');
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			// TLS-RPT still goes: it is about the mode, not about the provider.
			expect(domain!.dnsRecords.tlsRpt).toBeUndefined();
			expect(domain!.status).toBe('pending');
		});
	});
});

describe('lifecycle.setReceivingMode — external → owlat', () => {
	it('drops the provider include and restores the _smtp._tls record', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'back.example');

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});
		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'owlat',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.receivingMode).toBe('owlat');
			expect(domain!.externalReceivingProvider).toBeUndefined();
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			expect(domain!.dnsRecords.tlsRpt!.value).toBe(TLSRPT_VALUE);
		});
	});

	it('does not invent a TLS-RPT record when no reporting destination is configured', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'no-rua.example');

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});
		vi.stubEnv('MTA_TLSRPT_RUA', '');
		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'owlat',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.dnsRecords.tlsRpt).toBeUndefined();
		});
	});
});

describe('lifecycle.setReceivingMode — the cases that must NOT move records', () => {
	it('is a no-op when an absent mode is re-asserted as owlat', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'noop.example');

		const outcome = await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'owlat',
			userId: 'user',
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(false);

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// Still verified — an absent mode already MEANS owlat.
			expect(domain!.status).toBe('verified');
			expect(domain!.receivingMode).toBeUndefined();
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits).toHaveLength(0);
		});
	});

	it('REFUSES the switch while a registration is in flight', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'inflight.example', { status: 'registering' });

		const outcome = await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});

		// Storing the mode here would not make the in-flight registration honour
		// it: `registerAction.run` read the row before this mutation ran, and
		// nothing reconciles the mode afterwards, so the domain would end up
		// marked external while holding a bundle generated for `'owlat'` — and a
		// same-mode re-save short-circuits, so it would never self-heal.
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('registering');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.status).toBe('registering');
			expect(domain!.receivingMode).toBeUndefined();
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			const audits = await ctx.db
				.query('auditLogs')
				.filter((q) => q.eq(q.field('resourceId'), domainId))
				.collect();
			expect(audits).toHaveLength(0);
		});
	});

	it('keeps a registration-FAILED domain failed instead of flipping it to pending', async () => {
		const t = convexTest(schema, modules);
		// What a failed registration actually leaves behind: no bundle at all and
		// the provider error the panel shows with a "try again" path.
		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain: 'broken.example',
				status: 'failed',
				providerType: 'mta',
				dnsRecords: {},
				lastRegistrationError: 'MTA unreachable',
				createdAt: 1,
				updatedAt: 1,
			})
		);
		// Give it the one record a switch could move, so the status decision is the
		// only thing under test.
		await t.run(async (ctx) =>
			ctx.db.patch(domainId, {
				receivingMode: 'external',
				externalReceivingProvider: 'google',
				dnsRecords: { spf: { type: 'TXT', host: '@', value: OUR_SPF } },
			})
		);

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'owlat',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// `pending` would claim this domain is merely waiting on the operator's
			// DNS, with no DKIM to publish and the real failure hidden.
			expect(domain!.status).toBe('failed');
			expect(domain!.lastRegistrationError).toBe('MTA unreachable');
			expect(domain!.receivingMode).toBe('owlat');
		});
	});

	it('never deletes a TLSA association stored under the legacy tlsRpt field', async () => {
		const t = convexTest(schema, modules);
		const domainId = await t.run(async (ctx) =>
			ctx.db.insert('domains', {
				domain: 'dane.example',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: OUR_SPF },
					// Rows that predate the dedicated `tlsa` field keep the DANE
					// association here, and the verifier still reads it that way.
					tlsRpt: { type: 'TLSA', host: '_25._tcp.mail', value: '3 1 1 abcdef' },
				},
				createdAt: 1,
				updatedAt: 1,
			})
		);

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			// Withdrawing the operator's TLSA record because their INBOUND mail moved
			// would break DANE for a reason that has nothing to do with the mode.
			expect(domain!.dnsRecords.tlsRpt).toEqual({
				type: 'TLSA',
				host: '_25._tcp.mail',
				value: '3 1 1 abcdef',
			});
			expect(domain!.dnsRecords.spf!.value).toBe(
				'v=spf1 include:spf.owlat.example include:_spf.google.com ~all'
			);
		});
	});

	it('never rebuilds a relay provider’s SPF from our own include', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'ses.example', { providerType: 'ses' });

		await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.receivingMode).toBe('external');
			// That record describes SES's sending hosts; rebuilding it from
			// MTA_SPF_INCLUDE would authorize the wrong sender. It is therefore left
			// UNMERGED — which is honest only because the panel derives its "SPF is
			// already merged" claim from the record (`externalReceivingSpfMerged`)
			// and tells this operator to add the include themselves.
			expect(domain!.dnsRecords.spf!.value).toBe(OUR_SPF);
			expect(domain!.dnsRecords.tlsRpt!.value).toBe(TLSRPT_VALUE);
			// Nothing to republish ⇒ no gratuitous downgrade.
			expect(domain!.status).toBe('verified');
		});
	});

	it('returns domain_not_found for a row that is gone', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'doomed.example');
		await t.run(async (ctx) => ctx.db.delete(domainId));

		const outcome = await t.mutation(internal.domains.lifecycle.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
			userId: 'user',
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('domain_not_found');
	});
});

describe('domains.setReceivingMode — authorization', () => {
	it('rejects a non-admin member (editor) with forbidden', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'gated.example');
		mockRole = 'editor';

		const category = await t
			.withIdentity(identity)
			.mutation(api.domains.domains.setReceivingMode, { domainId, mode: 'external' })
			.then(() => undefined)
			.catch((e: { data?: { category?: string } }) => e?.data?.category);
		expect(category).toBe('forbidden');

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.receivingMode).toBeUndefined();
		});
	});

	it('tells an operator to wait instead of silently storing a mode mid-setup', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'setup.example', { status: 'registering' });
		mockRole = 'admin';

		const error = await t
			.withIdentity(identity)
			.mutation(api.domains.domains.setReceivingMode, { domainId, mode: 'external' })
			.then(() => undefined)
			.catch((e: { data?: { category?: string; message?: string } }) => e?.data);
		expect(error?.category).toBe('invalid_state');
		expect(error?.message).toContain('Wait for setup to finish');
	});

	it('lets an admin switch the mode through the public shell', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedVerifiedDomain(t, 'admin.example');
		mockRole = 'admin';

		await t.withIdentity(identity).mutation(api.domains.domains.setReceivingMode, {
			domainId,
			mode: 'external',
			provider: 'google',
		});

		await t.run(async (ctx) => {
			const domain = await ctx.db.get(domainId);
			expect(domain!.receivingMode).toBe('external');
			expect(domain!.externalReceivingProvider).toBe('google');
		});
	});
});
