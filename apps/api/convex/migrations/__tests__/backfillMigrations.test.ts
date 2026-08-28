/**
 * H2 backfill migrations — behaviour with the MTA HTTP client mocked.
 *
 *   0039 — DKIM org-ownership: walks the `domains` table, registers each OWN-MTA
 *     domain with the singleton org (backfilling ownership), skips other-provider
 *     domains (they have no MTA DKIM key), and logs-and-skips a cross-org 409
 *     without aborting the run.
 *   0040 — credential allowedDomains: patches each of the org's credentials whose
 *     set is empty/unset with the org's VERIFIED sending domains, leaves an
 *     already-scoped credential alone, and refuses to patch anything when there
 *     are no verified domains (an empty set would fail closed and lock sending).
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

// Resolve the domain owner without a real BetterAuth org (this is an action).
vi.mock('../../lib/sessionOrganization', async (importActual) => {
	const actual = await importActual<typeof import('../../lib/sessionOrganization')>();
	return { ...actual, getSingletonOrganizationId: vi.fn(async () => 'org-1') };
});

const registerDomainMock = vi.fn();
const listOrgCredentialsMock = vi.fn();
const setCredentialAllowedDomainsMock = vi.fn();
vi.mock('../../lib/emailProviders/mtaIdentity', async (importActual) => {
	const actual = await importActual<typeof import('../../lib/emailProviders/mtaIdentity')>();
	return {
		...actual,
		createMtaIdentityManager: () => ({
			registerDomain: registerDomainMock,
			deleteDomain: vi.fn(),
			listOrgCredentials: listOrgCredentialsMock,
			setCredentialAllowedDomains: setCredentialAllowedDomainsMock,
		}),
	};
});

const NOW = 1_700_000_000_000;

beforeEach(() => {
	registerDomainMock.mockReset();
	listOrgCredentialsMock.mockReset();
	setCredentialAllowedDomainsMock.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

async function seedDomain(
	t: ReturnType<typeof convexTest>,
	domain: string,
	status: 'registering' | 'pending' | 'verified' | 'failed',
	providerType: string | undefined
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain,
			status,
			dnsRecords: {},
			...(providerType !== undefined ? { providerType } : {}),
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

describe('0039 — DKIM ownership backfill', () => {
	it('backfills own-MTA domains, skips other providers, and survives a 409', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, 'owned.com', 'verified', 'mta');
		await seedDomain(t, 'legacy.com', 'verified', undefined); // legacy: no providerType
		await seedDomain(t, 'already.com', 'verified', 'mta');
		await seedDomain(t, 'conflict.com', 'verified', 'mta');
		await seedDomain(t, 'ses.com', 'verified', 'ses');
		await seedDomain(t, 'mandrill.com', 'verified', 'mandrill');

		registerDomainMock.mockImplementation(async (domain: string) => {
			if (domain === 'conflict.com') {
				throw new Error(
					'MTA DKIM registration failed (409): already registered to a different organization'
				);
			}
			if (domain === 'already.com') {
				return { selector: 's1', dnsRecord: 'v=DKIM1; p=K', ownership: 'unchanged' };
			}
			return { selector: 's1', dnsRecord: 'v=DKIM1; p=K', ownership: 'assigned' };
		});

		const result = await t.action(internal.migrations['0039_backfill_dkim_ownership'].run, {});

		expect(result).toEqual({ owned: 2, alreadyOwned: 1, conflicts: 1, skipped: 2 });

		// Only own-MTA domains were registered, each with the singleton org.
		const registered = registerDomainMock.mock.calls.map((c) => c[0]).sort();
		expect(registered).toEqual(['already.com', 'conflict.com', 'legacy.com', 'owned.com']);
		for (const call of registerDomainMock.mock.calls) {
			expect(call[1]).toBeUndefined(); // returnPathHost omitted → existing override preserved
			expect(call[2]).toBe('org-1'); // organizationId
		}
	});

	it('is a no-op on an instance with no domains', async () => {
		const t = convexTest(schema, modules);
		const result = await t.action(internal.migrations['0039_backfill_dkim_ownership'].run, {});
		expect(result).toEqual({ owned: 0, alreadyOwned: 0, conflicts: 0, skipped: 0 });
		expect(registerDomainMock).not.toHaveBeenCalled();
	});
});

describe('0040 — credential allowedDomains backfill', () => {
	it('patches empty/unset credentials with the verified domains, leaving scoped ones alone', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, 'brand.com', 'verified', 'mta');
		await seedDomain(t, 'brand.net', 'verified', 'mta');
		await seedDomain(t, 'pending.com', 'pending', 'mta'); // excluded — not verified

		listOrgCredentialsMock.mockResolvedValue([
			{
				apiKey: 'owlat_unset',
				credential: { organizationId: 'org-1', name: 'Unset', createdAt: NOW },
			},
			{
				apiKey: 'owlat_empty',
				credential: { organizationId: 'org-1', name: 'Empty', createdAt: NOW, allowedDomains: [] },
			},
			{
				apiKey: 'owlat_scoped',
				credential: {
					organizationId: 'org-1',
					name: 'Scoped',
					createdAt: NOW,
					allowedDomains: ['old.com'],
				},
			},
		]);

		const result = await t.action(
			internal.migrations['0040_backfill_credential_allowed_domains'].run,
			{}
		);

		expect(result).toEqual({ patched: 2, alreadyScoped: 1, skipped: 0, verifiedDomains: 2 });

		expect(listOrgCredentialsMock).toHaveBeenCalledWith('org-1');
		expect(setCredentialAllowedDomainsMock).toHaveBeenCalledTimes(2);
		const patchedKeys = setCredentialAllowedDomainsMock.mock.calls.map((c) => c[0]).sort();
		expect(patchedKeys).toEqual(['owlat_empty', 'owlat_unset']);
		for (const call of setCredentialAllowedDomainsMock.mock.calls) {
			expect((call[1] as string[]).sort()).toEqual(['brand.com', 'brand.net']);
		}
	});

	it('refuses to patch when there are no verified domains (fail-closed lockout guard)', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t, 'pending.com', 'pending', 'mta'); // no verified domains

		listOrgCredentialsMock.mockResolvedValue([
			{
				apiKey: 'owlat_unset',
				credential: { organizationId: 'org-1', name: 'Unset', createdAt: NOW },
			},
		]);

		const result = await t.action(
			internal.migrations['0040_backfill_credential_allowed_domains'].run,
			{}
		);

		expect(result).toEqual({ patched: 0, alreadyScoped: 0, skipped: 1, verifiedDomains: 0 });
		expect(setCredentialAllowedDomainsMock).not.toHaveBeenCalled();
	});
});
