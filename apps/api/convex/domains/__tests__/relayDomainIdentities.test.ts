/**
 * THE RELAY-DOMAIN IDENTITY READ ANSWERS FOR WHATEVER THE REGISTRY PROVES —
 * including a kind that does not exist in this repository.
 *
 * The vendor cases (SES's frozen sibling, Mandrill's derived records) live in
 * `__tests__/providerRoutes.integration.test.ts` beside the drain that writes
 * them. What needs its OWN file is the third kind, because proving it requires
 * composing a bundled plugin transport into the generated catalogs — a
 * module-level `vi.mock` that would change what every other test in that file
 * sees.
 *
 * WHAT IT PINS, and why each half matters:
 *
 *  - a plugin relay identity WRITTEN THROUGH THE GENERIC PERSISTENCE is VISIBLE.
 *    That is the failure this whole change undoes: the plugin tier shipped its
 *    write path into `sendingDomainRelayIdentities` while the read surface was
 *    two per-vendor queries, so a deployment relaying through a bundled
 *    transport was told "provisioning is queued" forever, about a run that had
 *    already finished.
 *  - the LABEL comes from the composed catalog. A plugin kind is
 *    `plugin.<id>.<local>`, which is not a name to show an operator, and no
 *    literal in a query or a panel could hold it anyway.
 *  - the row is answered even for a kind whose adapter implements NO describe
 *    seam, from the generic read of the shared row. Registering is what makes a
 *    kind visible; implementing the seam only adds detail.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KIND = 'plugin.mail-pack.postmark';
const PLUGIN_ID = 'mail-pack';
const LABEL = 'Postmark';
const DOMAIN = 'relay.example';
const TEST_ORG_ID = 'org-test';

const permissionState = vi.hoisted(() => ({ allowed: true }));

vi.mock('../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: LABEL,
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			domainVerification: 'api',
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportDomainIdentityCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: LABEL,
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			requiredEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportDomainIdentityModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			module: {
				registerDomain: async () => ({ outcome: 'unavailable', error: 'not called here' }),
				checkDomain: async () => ({ outcome: 'unavailable', error: 'not called here' }),
			},
		}),
	]),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue(TEST_ORG_ID),
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			if (!permissionState.allowed) throw new Error('Missing required permission');
			return { userId: 'test-user', role: 'owner' };
		}),
	};
});

const schema = (await import('../../schema')).default;
const { modules } = await import('../../__tests__/testModules');
const { api } = await import('../../_generated/api');
const { upsertPluginRelayIdentity } = await import('../providers/plugin/persistence');
const { describeSharedRelayIdentity } = await import('../providers/relayIdentityView');
const { PLUGIN_RELAY_PROOF_MAX_AGE_MS } = await import('../providers/plugin/state');

const identity = { subject: 'test-user', issuer: 'https://test', tokenIdentifier: 'test|user' };

// Derived from the CALL rather than from `typeof convexTest`: the bare return
// type is the generic-schema one, which this deployment's schema is not
// assignable to.
function harness() {
	return convexTest(schema, modules).withIdentity(identity);
}
type TestConvex = ReturnType<typeof harness>;

async function seedOwnedDomain(t: TestConvex): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain: DOMAIN,
			providerType: 'mta',
			status: 'verified',
			dnsRecords: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function listRows(t: TestConvex) {
	const result = await t.query(api.providerRoutes.listRelayDomainIdentities, {
		paginationOpts: { cursor: null, numItems: 50 },
	});
	return result.page;
}

beforeEach(() => {
	permissionState.allowed = true;
});

describe('a bundled plugin relay identity', () => {
	it('is visible, labelled and dated once the generic persistence has written it', async () => {
		const t = harness();
		await seedOwnedDomain(t);
		const checkedAt = Date.now();
		// WRITTEN THROUGH THE TIER'S OWN PERSISTENCE, not hand-inserted: the point
		// of the test is that what the shipped write path produces is what the read
		// surface can now render.
		await t.run(async (ctx) => {
			await upsertPluginRelayIdentity(
				ctx,
				KIND,
				DOMAIN,
				{
					status: 'verified',
					spf: { isValid: true },
					dkim: { isValid: true },
					dkimSelectors: ['pm-bounces'],
					spfMechanisms: ['include:spf.postmarkapp.example'],
				},
				checkedAt
			);
		});

		expect(await listRows(t)).toMatchObject([
			{
				domain: DOMAIN,
				kind: KIND,
				// The catalog's label, not the namespaced kind — which is what a
				// panel would otherwise have had to render, having no map that could
				// contain a kind decided at composition time.
				kindLabel: LABEL,
				status: 'verified',
				spf: { isValid: true },
				dkim: { isValid: true },
				lastCheckedAt: checkedAt,
				// The host's bound, reported so the surface ages this proof exactly
				// when routing stops trusting it.
				proofMaxAgeMs: PLUGIN_RELAY_PROOF_MAX_AGE_MS,
			},
		]);
	});

	it('reports the DNS facts a plugin can supply, as facts rather than as records', async () => {
		// A plugin identity module reports which selectors sign and which SPF
		// mechanisms authorise; it never reports the zone rows to publish. So they
		// arrive labelled and WITHOUT a `type`/`host` — the difference between
		// telling an operator what must be true and telling them what to paste.
		const t = harness();
		await seedOwnedDomain(t);
		await t.run(async (ctx) => {
			await upsertPluginRelayIdentity(
				ctx,
				KIND,
				DOMAIN,
				{
					status: 'pending_dns',
					spf: { isValid: false, error: 'no matching include found' },
					dkim: { isValid: true },
					dkimSelectors: ['pm-bounces'],
					spfMechanisms: ['include:spf.postmarkapp.example'],
				},
				Date.now()
			);
		});

		const [row] = await listRows(t);
		expect(row?.status).toBe('pending');
		expect(row?.records).toEqual([
			{ label: 'SPF mechanism', value: 'include:spf.postmarkapp.example' },
			{ label: 'DKIM selector', value: 'pm-bounces' },
		]);
		// The provider's own words, verbatim — it is the authority on whether the
		// published record is the one it wants.
		expect(row?.spf).toEqual({ isValid: false, error: 'no matching include found' });
	});

	it('reports a rejected credential without discarding the DNS the operator earned', async () => {
		const t = harness();
		await seedOwnedDomain(t);
		await t.run(async (ctx) => {
			await upsertPluginRelayIdentity(
				ctx,
				KIND,
				DOMAIN,
				{
					status: 'pending_dns',
					spf: { isValid: true },
					dkim: { isValid: true },
					dkimSelectors: ['pm-bounces'],
					spfMechanisms: [],
				},
				Date.now()
			);
			const { markPluginRelayIdentityFailed } = await import('../providers/plugin/persistence');
			await markPluginRelayIdentityFailed(ctx, KIND, DOMAIN, 'API token rejected', Date.now());
		});

		const [row] = await listRows(t);
		expect(row?.status).toBe('failed');
		expect(row?.lastError).toBe('API token rejected');
		expect(row?.records).toEqual([{ label: 'DKIM selector', value: 'pm-bounces' }]);
	});

	it('is answered for even before it has an identity, once it is the configured hatch', async () => {
		const t = harness();
		await seedOwnedDomain(t);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'transactional',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				deliverabilityFallback: {
					isEnabled: false,
					relayProviderType: KIND,
					isWarmupOverflowEnabled: false,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		expect(await listRows(t)).toMatchObject([
			{ domain: DOMAIN, kind: KIND, kindLabel: LABEL, status: 'provisioning', records: [] },
		]);
	});

	it('stays admin-gated, exactly as the vendor-shaped read it replaced was', async () => {
		const t = harness();
		permissionState.allowed = false;
		await expect(listRows(t)).rejects.toThrow('Missing required permission');
	});
});

describe('the default answer for a kind with no describe seam', () => {
	it('normalizes the shared row without knowing anything about the kind', async () => {
		// THE FLOOR EVERY REGISTERED KIND GETS. All three shipped kinds implement
		// `describeRelayIdentity`, so this path has no caller today — and that is
		// exactly why it is pinned directly: it is what a relay registered
		// tomorrow renders with before anyone writes a line of per-kind code, and
		// a regression in it would be invisible until that kind existed.
		const t = harness();
		await t.run(async (ctx) => {
			await upsertPluginRelayIdentity(
				ctx,
				'kind-that-describes-nothing',
				DOMAIN,
				{
					status: 'pending_dns',
					spf: { isValid: false, error: 'not published' },
					dkim: { isValid: true },
					dkimSelectors: [],
					spfMechanisms: [],
				},
				1_000
			);
		});

		const facts = await t.run(
			async (ctx) => await describeSharedRelayIdentity(ctx, 'kind-that-describes-nothing', DOMAIN)
		);
		expect(facts).toMatchObject({
			// The table's `pending_dns` in the surface's vocabulary…
			status: 'pending',
			// …the provider's verdicts, verbatim…
			spf: { isValid: false, error: 'not published' },
			dkim: { isValid: true },
			lastCheckedAt: 1_000,
			// …and NO records, because where a kind's DNS comes from is exactly the
			// knowledge a generic read does not have. Guessing would put DNS on an
			// operator's screen that no provider ever asked for.
			records: [],
		});
		expect(await t.run(async (ctx) => await describeSharedRelayIdentity(ctx, 'ses', DOMAIN))).toBe(
			null
		);
	});
});
