/**
 * THE READINESS PROJECTION `deployment.relay` RUNS ON (the seams plan's P0.4).
 *
 * The validator is a Node-runtime function with no `ctx`, so the only
 * configured-ness it could compute unaided is env presence. That answer agrees
 * with `setRoute` on every core kind and disagrees on exactly one tier: a
 * BUNDLED PLUGIN transport keeps its env vars when its `send:transport` grant
 * is revoked. `resolveRoute` then stops using it as the fallback while an
 * env-only checklist goes on reporting "the deliverability fallback relay is
 * enabled and every relay identity has a current provider and SPF proof" — the
 * operator is told the thing that will never be used works.
 *
 * So the query half resolves `isSendProviderReady`, the same authority the
 * mutation uses, and projects the answer onto the verification context. These
 * cases hold everything else constant — same route row, same env, same
 * plugin — and move only the grant, which is the one input an env read cannot
 * see. The sibling suite (`./checklistRelayReadiness.test.ts`) proves the
 * validator asks the projection; this one proves the projection is the
 * mutation's answer.
 */

import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mail-pack.postmark',
			pluginId: 'mail-pack',
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mail-pack',
			manifest: Object.freeze({
				id: 'mail-pack',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['POSTMARK_TOKEN']),
				}),
			}),
		}),
	]),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getSingletonOrganizationId: vi.fn(async () => 'organization-id'),
		requireOrgPermission: vi.fn(async () => ({ userId: 'test-user', role: 'owner' })),
	};
});

import schema from '../../schema';
import { internal } from '../../_generated/api';
import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';

const PLUGIN_KIND = 'plugin.mail-pack.postmark';
const PLUGIN_FLAG = 'plugin.mail-pack';
// Vite resolves `../../**` from this directory, which SKIPS the sibling
// `delivery/` tree the query under test lives in — the same two-glob merge every
// convex-test suite under `delivery/__tests__` performs.
const modules = {
	...import.meta.glob('../../**/*.*s'),
	...Object.fromEntries(
		Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
			path.replace(/^\.\.\//, '../../delivery/'),
			module,
		])
	),
};

/**
 * One route whose enabled deliverability fallback names `relayKind`, carrying
 * the own arm it would fall back FROM — i.e. a route shape `setRoute` accepts,
 * so nothing but readiness can be what a verdict turns on.
 */
async function seed(relayKind: string, isGranted: boolean) {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			featureFlags: { [PLUGIN_FLAG]: true },
			pluginCapabilityGrants: { [PLUGIN_FLAG]: { 'send:transport': isGranted } },
			createdAt: 0,
			updatedAt: 0,
		});
		await ctx.db.insert('providerRoutes', {
			messageType: 'transactional',
			strategy: 'single',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: relayKind, isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: relayKind,
				isWarmupOverflowEnabled: false,
			},
			createdAt: 0,
			updatedAt: 0,
		});
	});
	return t;
}

const readyKinds = async (t: Awaited<ReturnType<typeof seed>>): Promise<readonly string[]> =>
	(
		await t.query(internal.delivery.checklist.getVerificationContext, {
			organizationId: 'organization-id',
			itemId: 'deployment.relay',
		})
	).readyRelayKinds;

describe('deployment.relay readiness projection', () => {
	beforeEach(() => {
		_resetSingletonOrgCacheForTests();
		vi.unstubAllEnvs();
		vi.stubEnv('POSTMARK_TOKEN', 'present');
	});

	it('names a plugin relay whose capability grant is current', async () => {
		expect(await readyKinds(await seed(PLUGIN_KIND, true))).toEqual([PLUGIN_KIND]);
	});

	it('drops a plugin relay whose grant has been revoked, with its env intact', async () => {
		// THE CASE `providerKindConfigured` CANNOT SEE. `POSTMARK_TOKEN` is still
		// present and the route is unchanged; only the grant moved. An env-only
		// readiness source returns the kind here, and `deployment.relay` then
		// reports a fallback that `resolveRoute` will never select as ready.
		expect(await readyKinds(await seed(PLUGIN_KIND, false))).toEqual([]);
	});

	it('drops a plugin relay whose credentials are absent, grant intact', async () => {
		vi.stubEnv('POSTMARK_TOKEN', '');
		expect(await readyKinds(await seed(PLUGIN_KIND, true))).toEqual([]);
	});

	it('names a core relay on credentials alone — no grant exists to ask for', async () => {
		vi.stubEnv('AWS_SES_REGION', 'eu-central-1');
		vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'AKIA-test');
		vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
		expect(await readyKinds(await seed('ses', true))).toEqual(['ses']);
	});

	it('drops a kind that is not in the catalog at all rather than throwing on it', async () => {
		// A route row is free-form: a kind retired since the row was written, or one
		// a newer deployment named, must fail closed and not take the whole
		// Deliverability Center query down with a lookup that throws.
		expect(await readyKinds(await seed('postmark', true))).toEqual([]);
	});
});
