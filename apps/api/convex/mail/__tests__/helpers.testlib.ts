/**
 * Shared scaffolding for the `mail/*` Convex tests.
 *
 * `modules` is the filtered + re-rooted `import.meta.glob` map convex-test
 * needs, and `seedMailbox` inserts a `mailboxes` row. Both were previously
 * copied verbatim between `permissions.test.ts` and `mailboxAccess.test.ts`.
 *
 * The per-file `vi.mock('../../lib/sessionOrganization', …)` stays local to
 * each test (it hoists a file-scoped mock fn), so this module deliberately
 * exports no session helpers.
 *
 * The `.testlib.ts` (double-dot) name keeps Convex from bundling this file:
 * its entry-point filter skips any basename with more than one dot, which is
 * also how the sibling `*.test.ts` specs are excluded. A single-dot name would
 * be pushed to the deployment, where `import.meta.glob` crashes the isolate.
 */

import type { TestConvex } from 'convex-test';
import type { Id } from '../../_generated/dataModel';
import schema from '../../schema';

// The node-only / agent modules can't load in the test isolate; filter them
// out. Sibling `mail/*` modules glob in as `../foo.ts` (this dir is
// `mail/__tests__/`); convex-test resolves function paths from the convex
// root, so re-root them to `../../mail/foo.ts` — otherwise a
// `t.query(api.mail.…)` can't find the module.
const allModules = import.meta.glob('../../**/*.*s');

export const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agentSecurity') &&
				!path.includes('agentContext') &&
				!path.includes('agentClassifier') &&
				!path.includes('agentDrafter') &&
				!path.includes('agentRouter') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/shared') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

export type MailboxSeed = {
	userId?: string;
	organizationId?: string;
	address?: string;
	domain?: string;
	status?: 'active' | 'suspended' | 'deleted';
	scope?: 'personal' | 'shared';
	kind?: 'hosted' | 'external';
};

/** Insert a `mailboxes` row and return its id. */
export async function seedMailbox(
	t: TestConvex<typeof schema>,
	seed: MailboxSeed = {}
): Promise<Id<'mailboxes'>> {
	let id!: Id<'mailboxes'>;
	await t.run(async (ctx) => {
		const now = Date.now();
		id = await ctx.db.insert('mailboxes', {
			userId: seed.userId ?? 'user-A',
			organizationId: seed.organizationId ?? 'org-1',
			address: seed.address ?? 'a@hinterland.camp',
			domain: seed.domain ?? 'hinterland.camp',
			...(seed.scope ? { scope: seed.scope } : {}),
			...(seed.kind ? { kind: seed.kind } : {}),
			status: seed.status ?? 'active',
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
	});
	return id;
}
