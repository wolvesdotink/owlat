/**
 * WHOSE DOMAIN MAY CARRY A COEXISTING RELAY IDENTITY — asked as own-vs-not-own,
 * and INCLUDING the legacy row that never recorded a provider (the seams plan's
 * P0.4).
 *
 * A relay identity coexists on a domain whose PRIMARY provider is our own
 * infrastructure; a domain already hosted at some provider owns its identity
 * through the ordinary lifecycle. The gate used to be spelled
 * `providerType !== 'ses'` — the relay's name standing in for the rule, which
 * had to be re-read every time a second relay kind landed.
 *
 * THE CASE THIS SUITE EXISTS FOR is `providerType: undefined`. `domains` types
 * it `v.optional(v.string())`, so a row written before the field existed carries
 * nothing while being, in fact, an own-MTA domain — and the old `!== 'ses'`
 * admitted it. Answering the gate with a bare `=== OWN_SENDING_DOMAIN_PROVIDER_KIND`
 * would silently drop it, and the symptom is invisible: the relay proof stops
 * being refreshed, `verifiedAt` goes stale, `deployment.relay` warns forever and
 * no operator action clears it. `isOwnPrimarySendingDomain` is that reading,
 * stated once; this pins it.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import type { Id } from '../../_generated/dataModel';

vi.mock('node:dns/promises', () => ({
	default: {
		resolveTxt: vi.fn().mockRejectedValue(new Error('no txt')),
		resolveMx: vi.fn().mockRejectedValue(new Error('no mx')),
		resolveCname: vi.fn().mockRejectedValue(new Error('no cname')),
		resolve: vi.fn().mockRejectedValue(new Error('no record')),
		resolve4: vi.fn().mockRejectedValue(new Error('no a')),
		reverse: vi.fn().mockRejectedValue(new Error('no ptr')),
	},
}));

/**
 * The SES adapter, stubbed at the network edge only: the real one would call
 * AWS. Everything this suite asserts is decided BEFORE the adapter is reached,
 * so a call to it is itself evidence that the gate let the row through.
 */
const { runProviderCheck } = vi.hoisted(() => ({
	runProviderCheck: vi.fn(async () => ({ verified: true })),
}));

vi.mock('../providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../providers')>();
	return {
		...actual,
		providerFor: (kind: string) =>
			kind === 'ses'
				? {
						kind: 'ses',
						runProviderCheck,
						verificationStatusFields: () => ({ sesStatus: 'Success' }),
					}
				: actual.providerFor(kind as Parameters<typeof actual.providerFor>[0]),
	};
});

type TestConvex = ReturnType<typeof convexTest>;

async function seedDomainWithSesSibling(
	t: TestConvex,
	providerType: string | undefined
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) => {
		const domainId = await ctx.db.insert('domains', {
			domain: 'coexisting.example.com',
			status: 'verified',
			...(providerType === undefined ? {} : { providerType }),
			dnsRecords: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		await ctx.db.insert('sendingDomainSesIdentities', {
			domainId,
			dkimTokens: ['one', 'two', 'three'],
			verificationToken: 'token',
			// The gate's other half: only a sibling that carries DNS records has
			// anything to re-verify.
			dnsRecords: { dkim: [] },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return domainId;
	});
}

describe('the coexisting-relay refresh runs for our own domains, legacy rows included', () => {
	it.each([
		{ label: 'a recorded own-MTA domain', providerType: 'mta' },
		{ label: 'a legacy row with no providerType', providerType: undefined },
	])('refreshes the relay identity on $label', async ({ providerType }) => {
		runProviderCheck.mockClear();
		const t = convexTest(schema, modules);
		const domainId = await seedDomainWithSesSibling(t, providerType);

		const result = await t.action(internal.domains.sesRelayVerification.refreshSesRelayIdentity, {
			domainId,
		});

		expect(result).toMatchObject({ refreshed: true });
		expect(runProviderCheck).toHaveBeenCalledOnce();
	});

	it.each([{ providerType: 'ses' }, { providerType: 'mandrill' }])(
		'leaves a $providerType-PRIMARY domain to its ordinary lifecycle',
		async ({ providerType }) => {
			runProviderCheck.mockClear();
			const t = convexTest(schema, modules);
			const domainId = await seedDomainWithSesSibling(t, providerType);

			const result = await t.action(internal.domains.sesRelayVerification.refreshSesRelayIdentity, {
				domainId,
			});

			expect(result).toEqual({ refreshed: false });
			expect(runProviderCheck).not.toHaveBeenCalled();
		}
	);
});
