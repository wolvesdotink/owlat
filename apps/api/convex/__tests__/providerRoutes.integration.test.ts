/**
 * Provider-routes mutation contract tests.
 *
 * The settings UI (apps/web .../delivery/provider-routing.vue) uses the shared
 * `result === undefined ⇒ failure` idiom from `useBackendOperation` to decide
 * whether to fire the success toast and close the confirm dialog. Because a
 * caught throw also resolves to `undefined`, every mutation that idiom guards
 * must resolve to a truthy value on success. These tests lock that contract in
 * for `removeRoute` (regression for the missing-return bug) and `setRoute`.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// `authedQuery`/`authedMutation` floor + the handler's own role check.
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const singleMtaRoute = {
	messageType: 'campaign' as const,
	strategy: 'single' as const,
	providers: [{ providerType: 'mta', isEnabled: true }],
};

describe('providerRoutes mutation contracts', () => {
	it('setRoute returns a truthy id the UI can use as a success signal', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const id = await t.mutation(api.providerRoutes.setRoute, singleMtaRoute);

		expect(id).toBeTruthy();
	});

	it('removeRoute returns a truthy value after deleting an existing route', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.mutation(api.providerRoutes.setRoute, singleMtaRoute);

		const result = await t.mutation(api.providerRoutes.removeRoute, {
			messageType: 'campaign',
		});

		// Regression: the handler used to resolve to `undefined`, which the
		// settings page reads as a failure (same as a caught throw) — so the
		// reset toast never fired and the confirm dialog stayed open.
		expect(result).not.toBeUndefined();
		expect(result).toEqual({ success: true });

		const remaining = await t.query(api.providerRoutes.listRoutes, {});
		expect(remaining).toHaveLength(0);
	});

	it('removeRoute returns a truthy value even when there is no route to remove', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const result = await t.mutation(api.providerRoutes.removeRoute, {
			messageType: 'transactional',
		});

		// A no-op delete (nothing configured) is still a successful reset.
		expect(result).toEqual({ success: true });
	});
});

describe('providerRoutes.listIpPools', () => {
	it('returns the canonical MTA IP-pool names the routing UI autocompletes', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const pools = await t.query(api.providerRoutes.listIpPools, {});

		// These names come from MTA_IP_POOL_NAMES (the SSOT for MtaExtras.ipPool).
		// The settings UI warns on anything outside this set.
		expect(pools).toEqual(['transactional', 'campaign']);
	});
});
