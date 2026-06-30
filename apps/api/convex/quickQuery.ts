/**
 * Quick Query
 *
 * Allows users to keyword-search the knowledge graph with a free-text question.
 * Runs the `knowledgeEntries` full-text search index and returns the matching
 * entries' content as the answer, with the entry titles as source citations.
 * This is a keyword search over knowledge entries — not a semantic/vector
 * search and not an LLM-synthesized answer over contacts or files.
 */

import { v } from 'convex/values';
import { authedMutation } from './lib/authedFunctions';
import { assertFeatureEnabled } from './lib/featureFlags';
import { requireOrgPermission } from './lib/sessionOrganization';

/**
 * Submit a quick query against the knowledge graph.
 * Searches knowledgeEntries via full-text search and returns a summary
 * built from matching entries along with source references.
 */
export const ask = authedMutation({
	args: {
		question: v.string(),
	},
	handler: async (ctx, args) => {
		// Gate on the same flag as the sibling knowledge search
		// (knowledge/graph.ts `search`): when knowledge is disabled this must not
		// run and dump entries. Assert the flag before the membership check so a
		// disabled feature fails the same way regardless of who is asking.
		await assertFeatureEnabled(ctx, 'ai.knowledge');

		// Reads org-internal knowledge entries — require an actual ORG MEMBER,
		// not merely an authenticated identity. `authedIdentityMutation` only
		// asserts "logged in", which let a non-member read the knowledge graph
		// (the documented authedIdentityMutation privilege-escalation pitfall).
		// `knowledge:read` is granted to every member role.
		await requireOrgPermission(ctx, 'knowledge:read');

		const question = args.question.trim();
		if (!question) {
			return {
				answer: 'Please enter a question.',
				sources: [],
			};
		}

		// Search the knowledge graph using the full-text search index
		const results = await ctx.db
			.query('knowledgeEntries')
			.withSearchIndex('search_knowledge', (q) =>
				q.search('searchableText', question),
			)
			.take(5);

		if (results.length === 0) {
			return {
				answer:
					"I couldn't find relevant information for your question. Try rephrasing or using different keywords.",
				sources: [],
			};
		}

		// Build a concise answer from the matching entries
		const answerParts: string[] = [];
		const sources: Array<{
			id: string;
			title: string;
			entryType: string;
		}> = [];

		for (const entry of results) {
			// Use the content directly; trim to a reasonable length per entry
			const snippet =
				entry.content.length > 300
					? entry.content.slice(0, 297) + '...'
					: entry.content;
			answerParts.push(`${entry.title}: ${snippet}`);

			sources.push({
				id: entry._id,
				title: entry.title,
				entryType: entry.entryType,
			});
		}

		const answer = answerParts.join('\n\n');

		return { answer, sources };
	},
});
