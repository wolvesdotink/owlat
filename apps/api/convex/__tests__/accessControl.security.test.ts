/**
 * Access-control regression tests.
 *
 * Convex publishes every non-`internal` query/mutation/action on the public
 * client API, so an anonymous internet caller can invoke any of them. These
 * tests lock in the secure-by-default remediation: each function that was
 * previously reachable unauthenticated must now reject a caller with no
 * session, and the functions that were demoted to `internal*` must no longer
 * appear on the public `api` surface at all.
 *
 * We assert the *category* of the thrown Operation error (`unauthenticated`),
 * not merely "it threw" — otherwise a malformed-args validation error would
 * masquerade as a passing auth check.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { FunctionReference } from 'convex/server';

// Same module filter the other integration suites use — drops the Node-only /
// heavy-import modules that convex-test cannot bundle in vitest.
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
			!path.includes('llmProvider') &&
			!path.includes('campaigns/testSend'),
	),
);

const PAGE = { paginationOpts: { cursor: null, numItems: 10 } };

/** Invoke `fn` with no identity and return the Operation error category (or undefined if it didn't throw). */
async function anonCategory(
	run: () => Promise<unknown>,
): Promise<string | undefined> {
	try {
		await run();
		return undefined;
	} catch (e) {
		return (e as { data?: { category?: string } })?.data?.category;
	}
}

describe('access control — unauthenticated callers are rejected', () => {
	// [label, FunctionReference, args] — every one was anonymously reachable
	// before the remediation. Each must now reject with `unauthenticated`.
	const queries: Array<[string, FunctionReference<'query'>, Record<string, unknown>]> = [
		['auth.apiKeys.listByTeam', api.auth.apiKeys.listByTeam, {}],
		['auth.accountManagement.exportContactsForOrganization', api.auth.accountManagement.exportContactsForOrganization, {}],
		['providerRoutes.listRoutes', api.providerRoutes.listRoutes, {}],
		['blockedEmails.listByTeam', api.blockedEmails.listByTeam, {}],
		['webhooks.endpoints.listByOrganization', api.webhooks.endpoints.listByOrganization, {}],
		['domains.domains.listByOrganization', api.domains.domains.listByOrganization, {}],
		['forms.endpoints.listByTeam', api.forms.endpoints.listByTeam, {}],
		['semanticFiles.list', api.semanticFiles.list, PAGE],
		['autonomy.listRules', api.autonomy.listRules, {}],
		['contacts.contacts.list', api.contacts.contacts.list, PAGE],
		['contacts.contacts.getAudienceStats', api.contacts.contacts.getAudienceStats, {}],
		['contacts.organization.listAllIdsByOrganization', api.contacts.organization.listAllIdsByOrganization, {}],
		['segments.list', api.segments.list, PAGE],
		['mediaAssets.list', api.mediaAssets.list, PAGE],
		['campaigns.campaigns.list', api.campaigns.campaigns.list, PAGE],
		['emailTemplates.emails.list', api.emailTemplates.emails.list, PAGE],
		['transactional.emails.list', api.transactional.emails.list, {}],
		['topics.topics.list', api.topics.topics.list, PAGE],
		['emailBlocks.blocks.list', api.emailBlocks.blocks.list, {}],
	];

	it.each(queries)('query %s rejects anonymous', async (_label, fn, args) => {
		const t = convexTest(schema, modules);
		expect(await anonCategory(() => t.query(fn, args))).toBe('unauthenticated');
	});

	const mutations: Array<[string, FunctionReference<'mutation'>, Record<string, unknown>]> = [
		['auth.apiKeys.create', api.auth.apiKeys.create, { name: 'k' }],
		['contacts.contacts.create', api.contacts.contacts.create, { email: 'a@example.com' }],
		['providerRoutes.setRoute', api.providerRoutes.setRoute, {
			messageType: 'campaign',
			strategy: 'single',
			providers: [{ providerType: 'mta', isEnabled: true }],
		}],
		['forms.endpoints.create', api.forms.endpoints.create, { name: 'Signup' }],
		['topics.topics.create', api.topics.topics.create, { name: 'News' }],
		['autonomy.upsertRule', api.autonomy.upsertRule, {
			category: 'reply',
			autoApproveThreshold: 0.9,
			maxDailyAutoActions: 5,
			isEnabled: true,
		}],
	];

	it.each(mutations)('mutation %s rejects anonymous', async (_label, fn, args) => {
		const t = convexTest(schema, modules);
		expect(await anonCategory(() => t.mutation(fn, args))).toBe('unauthenticated');
	});
});

// Note on what is NOT tested here: functions demoted to `internal*` (e.g.
// `automations.triggers.sendEvent`, `contacts.contacts.getInternal`,
// `topics.topics.{add,remove}ContactInternal`) are off the public client API,
// but that boundary is enforced by the production Convex server — the
// convex-test harness runs internal functions directly and does not model it,
// so it cannot be asserted here. Their internal-only status is enforced instead
// by the type system (callers use `internal.*`, see `eventsApi.ts` /
// `contacts/api.ts` / `topics/apiHttp.ts`) and by `scripts/check-public-functions.sh`.
