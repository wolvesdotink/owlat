/**
 * `mandrillRelay.provision` registers a coexisting Mandrill identity for a
 * domain some other provider owns, and leaves a Mandrill-primary domain to the
 * ordinary lifecycle, which already owns that domain's identity row.
 *
 * Mandrill's HTTP API is the only stub: the action, the query it reads through
 * and the mutation that stores the identity are the real ones.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';
import type * as SessionOrganizationModule from '../../lib/sessionOrganization';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganizationModule>(
		'../../lib/sessionOrganization'
	);
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const DOMAIN = 'acme.com';

let fetchMock: ReturnType<typeof vi.fn>;

function respondJson(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: new Headers(),
	} as unknown as Response;
}

beforeEach(() => {
	vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
	fetchMock = vi.fn().mockResolvedValue(
		respondJson({
			domain: DOMAIN,
			created_at: '2026-08-01 10:00:00',
			last_tested_at: '2026-08-04 10:00:00',
			spf: { valid: false, error: 'The SPF record is missing' },
			dkim: { valid: false, error: 'The DKIM record is missing' },
			verified_at: null,
			valid_signing: false,
		})
	);
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function seedDomain(
	t: ReturnType<typeof convexTest>,
	providerType: string | undefined
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('domains', {
			domain: DOMAIN,
			status: 'verified',
			...(providerType !== undefined ? { providerType } : {}),
			dnsRecords: {},
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function relayRows(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => await ctx.db.query('sendingDomainRelayIdentities').collect());
}

describe('mandrillRelay.provision', () => {
	it('skips a Mandrill-primary domain without calling Mandrill', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'mandrill');
		await expect(t.action(internal.domains.mandrillRelay.provision, { domainId })).resolves.toEqual(
			{
				provisioned: false,
			}
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await relayRows(t)).toEqual([]);
	});

	it.each([
		['an own-MTA domain', 'mta'],
		['an SES-primary domain', 'ses'],
		['a legacy row with no recorded kind', undefined],
	])('registers %s at Mandrill and stores the identity', async (_label, providerType) => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, providerType);
		await expect(t.action(internal.domains.mandrillRelay.provision, { domainId })).resolves.toEqual(
			{
				provisioned: true,
			}
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('add-domain');
		const rows = await relayRows(t);
		expect(rows.map((row) => [row.providerKind, row.domain])).toEqual([['mandrill', DOMAIN]]);
	});

	it('skips a domain that no longer exists', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t, 'mta');
		await t.run(async (ctx) => await ctx.db.delete(domainId));
		await expect(t.action(internal.domains.mandrillRelay.provision, { domainId })).resolves.toEqual(
			{
				provisioned: false,
			}
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
