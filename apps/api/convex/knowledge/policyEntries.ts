/**
 * The handlers of the curated policy / FAQ surface registered in
 * `knowledge/graph.ts`: writing a curated canonical answer and listing them.
 * The registrations stay in `graph.ts`, so callers keep the
 * `knowledge.graph.*` paths.
 */

import { v, type ObjectType } from 'convex/values';
import { literalUnion } from '../lib/literalUnion';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { isKnowledgeEntryVisible, pageLimit, resolveKnowledgeViewer } from './visibility';
import { throwInvalidInput } from '../_utils/errors';
import { entryKeysForType } from '../lib/aiRouting/embeddingRegistry';
import { noteCorpusInsert, patchCorpusRow } from '../lib/aiRouting/embeddingActivation';
import { POLICY_ENTRY_TYPES } from '../schema/knowledge';
import { syncCommitmentFacets } from './commitmentFacets';

/** Validator for the curated entry types (policy / faq). */
const policyEntryTypeValidator = literalUnion(POLICY_ENTRY_TYPES);

/** The args of `knowledge.graph.createPolicyEntry`. */
export const createPolicyEntryArgs = {
	entryId: v.optional(v.id('knowledgeEntries')),
	entryType: v.optional(policyEntryTypeValidator),
	title: v.string(),
	content: v.string(),
	tags: v.optional(v.array(v.string())),
	expiresAt: v.optional(v.number()),
};

/** `knowledge.graph.createPolicyEntry`: write or edit a curated canonical answer. */
export async function createPolicyEntryHandler(
	ctx: MutationCtx,
	args: ObjectType<typeof createPolicyEntryArgs>
) {
	if (args.title.trim().length === 0 || args.content.trim().length === 0) {
		throwInvalidInput('A curated answer needs both a question and an answer.');
	}

	const now = Date.now();
	const entryType = args.entryType ?? 'faq';
	const searchableText = `${args.title} ${args.content}`;

	if (args.entryId) {
		const existing = await ctx.db.get(args.entryId);
		if (!existing) return null;
		// Through the one corpus writer: input and eligibility
		// (expiry) changes clear the stale vectors and mark a staged rebuild.
		await patchCorpusRow(ctx, 'knowledgeEntries', existing, {
			entryType,
			...entryKeysForType(existing, entryType),
			title: args.title,
			content: args.content,
			sourceType: 'curated',
			// Where it came from, for sharing it with members later
			// (knowledge/sharing.ts). Re-saving a curated answer keeps what
			// it recorded; one written before the field stays unknown.
			curatedFromSourceType:
				existing.sourceType === 'curated' ? existing.curatedFromSourceType : existing.sourceType,
			isAuthoritative: true,
			tags: args.tags,
			expiresAt: args.expiresAt,
			searchableText,
			lastValidatedAt: now,
			updatedAt: now,
		});
		// A policy / faq is never a commitment: drop the entry's junction rows
		// out of the open-commitments index if it was one.
		await syncCommitmentFacets(ctx, args.entryId, {
			...existing,
			entryType,
			expiresAt: args.expiresAt,
		});
		return args.entryId;
	}

	const policyId = await ctx.db.insert('knowledgeEntries', {
		entryType,
		title: args.title,
		content: args.content,
		sourceType: 'curated',
		curatedFromSourceType: 'curated',
		isAuthoritative: true,
		// Stamped on every write of this release (knowledge/entryDedupe.ts).
		memberAccess: 'members',
		embedding: [], // filled by the embedding pipeline; FTS works immediately
		confidence: 1.0, // a human-authored canonical answer is fully trusted
		lastValidatedAt: now,
		expiresAt: args.expiresAt,
		tags: args.tags,
		searchableText,
		createdAt: now,
		updatedAt: now,
	});
	await noteCorpusInsert(ctx, 'knowledgeEntries', policyId);
	return policyId;
}

/** The args of `knowledge.graph.listPolicies`. */
export const listPoliciesArgs = {
	limit: v.optional(v.number()),
};

/** `knowledge.graph.listPolicies`: the visible curated answers, newest first. */
export async function listPoliciesHandler(
	ctx: QueryCtx,
	args: ObjectType<typeof listPoliciesArgs>
) {
	const viewer = await resolveKnowledgeViewer(ctx);
	if (!viewer) return [];

	const limit = pageLimit(args.limit, 100);
	const out: Doc<'knowledgeEntries'>[] = [];
	for (const entryType of POLICY_ENTRY_TYPES) {
		const rows = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_entry_type', (q) => q.eq('entryType', entryType))
			.order('desc')
			.take(limit);
		// Only human-curated canonical answers belong in the FAQ surface. The
		// extraction pipeline can emit `policy`/`faq` entries typed by the LLM
		// (sourceType 'agent_extracted', never authoritative); those must not
		// intermix with hand-authored answers here.
		for (const row of rows) {
			if (
				row.sourceType === 'curated' &&
				row.isAuthoritative === true &&
				isKnowledgeEntryVisible(viewer.canReadInbox, row)
			) {
				out.push(row);
			}
		}
	}
	out.sort((a, b) => b.createdAt - a.createdAt);
	return out.slice(0, limit);
}
