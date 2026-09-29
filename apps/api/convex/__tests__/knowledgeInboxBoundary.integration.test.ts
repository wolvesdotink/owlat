/**
 * Knowledge entries derived from Team Inbox mail follow the shared-inbox reader
 * rule (inbox/access.ts): owners and admins see them, other members do not, on
 * every public read and write, in retrieval, and in the assistant tool. Every
 * public knowledge function also follows the `ai.knowledge` flag.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestContact,
	createTestConversationThread,
	createTestKnowledgeEntry,
	enableFeatures,
} from './factories';
import type * as SessionOrganization from '../lib/sessionOrganization';

const sess = vi.hoisted(() => ({ role: 'editor' as 'owner' | 'admin' | 'editor' }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const session = () => ({
		userId: 'test-user',
		role: sess.role,
		activeOrganizationId: 'test-org',
	});
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn(async () => session()),
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => 'test-user'),
		getMutationContext: vi.fn(async () => session()),
		requireAdminContext: vi.fn(async () => {
			if (!actual.hasPermission(sess.role, 'organization:manage')) {
				throw new Error('Only owners and admins can perform this action');
			}
			return session();
		}),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('visualizationAgent') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('llmProvider')
	)
);

const DIM = 1536;
function unit(at: number): number[] {
	const vec = Array.from({ length: DIM }, () => 0);
	vec[at] = 1;
	return vec;
}

type T = ReturnType<typeof convexTest>;

async function makeT(flags: Parameters<typeof enableFeatures>[1] = ['ai.knowledge']): Promise<T> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	if (flags.length > 0) await enableFeatures(t, flags);
	return t;
}

/**
 * Three entries sharing one contact, one embedding and one search token:
 *   inbox    — extracted from an inbound Team Inbox message;
 *   threaded — a manual entry linked to a Team Inbox thread;
 *   open     — a manual entry with neither marker.
 * `open` has an outgoing relation to `inbox`.
 */
async function seed(t: T) {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const threadId = await ctx.db.insert(
			'conversationThreads',
			createTestConversationThread({ contactId, updatedAt: undefined })
		);
		const base = { contactIds: [contactId], embedding: unit(4) };
		const inbox = await ctx.db.insert(
			'knowledgeEntries',
			createTestKnowledgeEntry({
				...base,
				title: 'inbox fact',
				sourceType: 'agent_extracted',
				sourceId: 'inbound-1',
				searchableText: 'boundarytoken inbox fact',
				createdAt: 3,
			})
		);
		const threaded = await ctx.db.insert(
			'knowledgeEntries',
			createTestKnowledgeEntry({
				...base,
				title: 'threaded fact',
				sourceType: 'manual',
				threadId,
				searchableText: 'boundarytoken threaded fact',
				createdAt: 2,
			})
		);
		const open = await ctx.db.insert(
			'knowledgeEntries',
			createTestKnowledgeEntry({
				...base,
				title: 'open fact',
				sourceType: 'manual',
				searchableText: 'boundarytoken open fact',
				createdAt: 1,
			})
		);
		for (const entryId of [inbox, threaded, open]) {
			await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId });
		}
		const now = Date.now();
		const relationId = await ctx.db.insert('knowledgeRelations', {
			fromEntryId: open,
			toEntryId: inbox,
			relationType: 'supports',
			confidenceTag: 'extracted',
			confidence: 1,
			provenance: 'manual',
			createdAt: now,
			updatedAt: now,
		});
		return { contactId, threadId, inbox, threaded, open, relationId };
	});
}

function titles(rows: Array<{ title: string }> | null | undefined): string[] {
	return (rows ?? []).map((row) => row.title).sort();
}

beforeEach(() => {
	sess.role = 'editor';
});

describe('knowledge reads follow the shared-inbox reader rule', () => {
	it('hides inbox-derived entries from a member on every list read', async () => {
		const t = await makeT();
		const { contactId } = await seed(t);

		expect(titles(await t.query(api.knowledge.graph.listAll, {}))).toEqual(['open fact']);
		expect(titles(await t.query(api.knowledge.graph.listByType, { entryType: 'fact' }))).toEqual([
			'open fact',
		]);
		expect(
			titles(await t.query(api.knowledge.graph.search, { searchQuery: 'boundarytoken' }))
		).toEqual(['open fact']);
		expect(titles(await t.query(api.knowledge.graph.getByContact, { contactId }))).toEqual([
			'open fact',
		]);
	});

	it('shows every entry to an admin', async () => {
		const t = await makeT();
		const { contactId } = await seed(t);
		sess.role = 'admin';

		const all = ['inbox fact', 'open fact', 'threaded fact'];
		expect(titles(await t.query(api.knowledge.graph.listAll, {}))).toEqual(all);
		expect(
			titles(await t.query(api.knowledge.graph.search, { searchQuery: 'boundarytoken' }))
		).toEqual(all);
		expect(titles(await t.query(api.knowledge.graph.getByContact, { contactId }))).toEqual(all);
	});

	it('keeps a member page full when inbox-derived entries are the newest', async () => {
		const t = await makeT();
		await seed(t);

		const page = await t.query(api.knowledge.graph.listAll, { limit: 1 });
		expect(titles(page)).toEqual(['open fact']);
	});

	it('bounds the rows a member read scans, returning a short page past the bound', async () => {
		const t = await makeT();
		await seed(t);
		await t.run(async (ctx) => {
			for (let i = 0; i < 4; i++) {
				await ctx.db.insert(
					'knowledgeEntries',
					createTestKnowledgeEntry({ title: `newer inbox ${i}`, createdAt: 10 + i })
				);
			}
		});

		// A page of one scans four rows, all of them Team Inbox-derived.
		expect(await t.query(api.knowledge.graph.listAll, { limit: 1 })).toEqual([]);
		expect(titles(await t.query(api.knowledge.graph.listAll, { limit: 2 }))).toEqual([
			'open fact',
		]);
	});

	it('returns null for an inbox-derived entry and drops it from relations', async () => {
		const t = await makeT();
		const { inbox, threaded, open } = await seed(t);

		expect(await t.query(api.knowledge.graph.getEntry, { entryId: inbox })).toBeNull();
		expect(await t.query(api.knowledge.graph.getEntry, { entryId: threaded })).toBeNull();

		const view = await t.query(api.knowledge.graph.getEntry, { entryId: open });
		expect(view?.entry.title).toBe('open fact');
		expect(view?.outgoing).toEqual([]);
		expect(view?.relatedEntries).toEqual({});

		sess.role = 'owner';
		const ownerView = await t.query(api.knowledge.graph.getEntry, { entryId: open });
		expect(ownerView?.outgoing).toHaveLength(1);
		expect(ownerView?.relatedEntries[inbox]?.title).toBe('inbox fact');
	});

	it('leaves inbox-derived nodes out of the member subgraph', async () => {
		const t = await makeT(['ai.knowledge.analytics']);
		const { inbox, open } = await seed(t);

		const member = await t.query(api.knowledge.graphAnalytics.getSubgraph, { entryId: open });
		expect(member.nodes.map((n) => n.title)).toEqual(['open fact']);
		expect(member.edges).toEqual([]);
		const rooted = await t.query(api.knowledge.graphAnalytics.getSubgraph, { entryId: inbox });
		expect(rooted.nodes).toEqual([]);

		sess.role = 'admin';
		const admin = await t.query(api.knowledge.graphAnalytics.getSubgraph, { entryId: open });
		expect(admin.nodes.map((n) => n.title).sort()).toEqual(['inbox fact', 'open fact']);
	});
});

describe('knowledge graph insights follow the shared-inbox reader rule', () => {
	it('leaves inbox-derived entries out of the named hubs for a member', async () => {
		const t = await makeT(['ai.knowledge.analytics']);
		await seed(t);
		await t.action(internal.knowledge.graphAnalyticsRecompute.recomputeStats, {});

		const member = await t.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(member?.godNodes.map((n) => n.title)).toEqual(['open fact']);
		expect(member?.nodeCount).toBe(3);

		sess.role = 'owner';
		const owner = await t.query(api.knowledge.graphAnalytics.getGraphStats, {});
		expect(owner?.godNodes.map((n) => n.title).sort()).toEqual([
			'inbox fact',
			'open fact',
			'threaded fact',
		]);
	});
});

describe('knowledge writes follow the shared-inbox reader rule', () => {
	it('treats an inbox-derived entry as missing for a member', async () => {
		const t = await makeT();
		const { inbox, open, relationId } = await seed(t);

		expect(
			await t.mutation(api.knowledge.graph.updateEntry, { entryId: inbox, content: 'changed' })
		).toBeNull();
		expect(
			await t.mutation(api.knowledge.graph.setCommitmentStatus, {
				entryId: inbox,
				commitmentStatus: 'fulfilled',
			})
		).toBeNull();
		expect(await t.mutation(api.knowledge.graph.deleteEntry, { entryId: inbox })).toBeNull();
		expect(await t.mutation(api.knowledge.graph.removeRelation, { relationId })).toBeNull();
		await expect(
			t.mutation(api.knowledge.graph.addRelation, {
				fromEntryId: inbox,
				toEntryId: open,
				relationType: 'relates_to',
			})
		).rejects.toThrow(/must exist/);

		const [entry, relation] = await t.run(async (ctx) => [
			await ctx.db.get(inbox),
			await ctx.db.get(relationId),
		]);
		expect(entry?.content).not.toBe('changed');
		expect(entry?.commitmentStatus).toBeUndefined();
		expect(relation).not.toBeNull();
	});

	it('lets an admin edit and delete an inbox-derived entry', async () => {
		const t = await makeT();
		const { inbox } = await seed(t);
		sess.role = 'admin';

		expect(
			await t.mutation(api.knowledge.graph.updateEntry, { entryId: inbox, content: 'changed' })
		).toBe(inbox);
		expect(await t.mutation(api.knowledge.graph.deleteEntry, { entryId: inbox })).toBe(true);
	});

	it('refuses a member linking a new entry to a Team Inbox thread', async () => {
		const t = await makeT();
		const { threadId } = await seed(t);

		await expect(
			t.mutation(api.knowledge.graph.createEntry, {
				entryType: 'fact',
				title: 'linked',
				content: 'linked',
				sourceType: 'manual',
				threadId,
			})
		).rejects.toThrow(/Team Inbox/);

		sess.role = 'admin';
		const id = await t.mutation(api.knowledge.graph.createEntry, {
			entryType: 'fact',
			title: 'linked',
			content: 'linked',
			sourceType: 'manual',
			threadId,
		});
		expect(id).toBeDefined();
	});
});

describe('public knowledge functions follow the ai.knowledge flag', () => {
	it('returns nothing from the reads while the flag is off', async () => {
		const t = await makeT([]);
		const { contactId, open } = await seed(t);
		sess.role = 'owner';

		expect(await t.query(api.knowledge.graph.listAll, {})).toEqual([]);
		expect(await t.query(api.knowledge.graph.listByType, { entryType: 'fact' })).toEqual([]);
		expect(await t.query(api.knowledge.graph.getByContact, { contactId })).toEqual([]);
		expect(await t.query(api.knowledge.graph.listPolicies, {})).toEqual([]);
		expect(await t.query(api.knowledge.graph.getEntry, { entryId: open })).toBeNull();
		expect(await t.query(api.knowledge.edgeBackfill.getStatus, {})).toBeNull();
	});

	it('refuses the writes while the flag is off', async () => {
		const t = await makeT([]);
		const { open, relationId } = await seed(t);
		sess.role = 'owner';

		await expect(
			t.mutation(api.knowledge.graph.createEntry, {
				entryType: 'fact',
				title: 'x',
				content: 'x',
				sourceType: 'manual',
			})
		).rejects.toThrow(/ai\.knowledge/);
		await expect(
			t.mutation(api.knowledge.graph.updateEntry, { entryId: open, content: 'x' })
		).rejects.toThrow(/ai\.knowledge/);
		await expect(t.mutation(api.knowledge.graph.deleteEntry, { entryId: open })).rejects.toThrow(
			/ai\.knowledge/
		);
		await expect(
			t.mutation(api.knowledge.graph.setCommitmentStatus, {
				entryId: open,
				commitmentStatus: 'fulfilled',
			})
		).rejects.toThrow(/ai\.knowledge/);
		await expect(t.mutation(api.knowledge.graph.removeRelation, { relationId })).rejects.toThrow(
			/ai\.knowledge/
		);
		await expect(
			t.mutation(api.knowledge.graph.createPolicyEntry, { title: 'q', content: 'a' })
		).rejects.toThrow(/ai\.knowledge/);
		await expect(t.mutation(api.knowledge.edgeBackfill.cancel, {})).rejects.toThrow(
			/ai\.knowledge/
		);
	});
});

describe('retrieval leaves inbox-derived entries out unless asked for them', () => {
	it('filters the flat and the graph-expanded result', async () => {
		const t = await makeT();
		await seed(t);

		const member = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'boundarytoken',
			embedding: unit(4),
			scopeToContact: 'org-wide',
			includeInboxDerived: false,
			limit: 10,
		});
		expect(titles(member)).toEqual(['open fact']);

		const expanded = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'boundarytoken',
			embedding: unit(4),
			scopeToContact: 'org-wide',
			includeInboxDerived: false,
			expandGraph: true,
			limit: 10,
		});
		expect(titles(expanded)).toEqual(['open fact']);
		expect(expanded[0]?._via ?? []).toEqual([]);

		const reader = await t.action(internal.knowledge.retrieval.semanticSearch, {
			queryText: 'boundarytoken',
			embedding: unit(4),
			scopeToContact: 'org-wide',
			includeInboxDerived: true,
			limit: 10,
		});
		expect(titles(reader)).toEqual(['inbox fact', 'open fact', 'threaded fact']);
	});

	it('does not reach an inbox-derived neighbour from a visible seed', async () => {
		const t = await makeT();
		const { open } = await seed(t);

		const hidden = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [open],
			scope: 'org-wide',
			includeInboxDerived: false,
			hops: 1,
			neighborBudget: 8,
		});
		expect(hidden.neighbors).toEqual([]);
		expect(hidden.edges).toEqual([]);

		const shown = await t.query(internal.knowledge.graphTraversal.expandNeighbors, {
			seedIds: [open],
			scope: 'org-wide',
			includeInboxDerived: true,
			hops: 1,
			neighborBudget: 8,
		});
		expect(shown.neighbors.map((n) => n.title)).toEqual(['inbox fact']);
	});
});

describe('the assistant knowledge tool follows its audience', () => {
	it('records the owner as a reader only when they can read the Team Inbox', async () => {
		const t = await makeT(['ai.assistant']);
		const conversationId = await t.mutation(api.assistant.conversations.createConversation, {});
		await t.mutation(api.assistant.conversations.sendMessage, { conversationId, text: 'hi' });
		sess.role = 'admin';
		await t.mutation(api.assistant.conversations.sendMessage, { conversationId, text: 'hi' });

		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.name === 'assistant/runner:run'
			)
		);
		expect(
			scheduled.map((job) => (job.args[0] as { includeInboxDerived?: boolean }).includeInboxDerived)
		).toEqual([false, true]);
	});
});
