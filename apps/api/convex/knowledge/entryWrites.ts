/**
 * The handlers of the knowledge-entry writes registered in `knowledge/graph.ts`
 * that do not touch a relation: a hand-authored entry (create, edit,
 * commitment status), an entry the extraction pipeline saves, and the recall
 * counter. The registrations stay in `graph.ts`, so callers keep the
 * `knowledge.graph.*` paths. Each write keeps the entry's contact junction
 * rows, open-commitment facets and corpus bookkeeping in its own transaction.
 */

import { v, type ObjectType } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { hasPermission, requirePermission } from '../lib/sessionOrganization';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { isSharedInboxReader } from '../inbox/access';
import { loadWritableEntry } from './visibility';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { entryKeysForType } from '../lib/aiRouting/embeddingRegistry';
import {
	noteCorpusInsert,
	patchCorpusRow,
	vectorFieldsForCommit,
} from '../lib/aiRouting/embeddingActivation';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { logInfo } from '../lib/runtimeLog';
import { findDuplicateEntry, resolveMemberAccess } from './entryDedupe';
import { commitmentStatusValidator, knowledgeEntriesFields } from '../schema/knowledge';
import { optionalFields, pick } from '../lib/validators/fields';
import { commitmentFacetsOf, syncCommitmentFacets } from './commitmentFacets';
import { insertEntryContacts, syncEntryContacts } from './entryContacts';

/**
 * Curated answers (`isAuthoritative`) are what the agent quotes to customers
 * ahead of everything else, so only owners and admins may write them. Members
 * keep editing and deleting the rest of the graph.
 */
export function requireCuratedWriter(
	session: MutationSessionContext,
	entry: Pick<Doc<'knowledgeEntries'>, 'isAuthoritative'>
): void {
	if (entry.isAuthoritative !== true) return;
	requirePermission(
		hasPermission(session.role, 'organization:manage'),
		'Only owners and admins can change a curated answer'
	);
}

/** The args of `knowledge.graph.createEntry`. */
export const createEntryArgs = {
	...pick(knowledgeEntriesFields, [
		'entryType',
		'title',
		'content',
		'sourceType',
		'sourceId',
		'contactIds',
		'threadId',
		'tags',
		'expiresAt',
	]),
	// Defaults to 0.8 for a manually authored entry.
	confidence: v.optional(knowledgeEntriesFields.confidence),
};

/** `knowledge.graph.createEntry`: insert a hand-authored (`manual`) entry. */
export async function createEntryHandler(
	ctx: MutationCtx,
	args: ObjectType<typeof createEntryArgs>,
	session: MutationSessionContext
) {
	// A hand-authored entry is `manual`. The other sources name a pipeline
	// (extraction, files, chat, imported mail), and `agent_extracted` in
	// particular marks an entry as Team Inbox-derived (inbox/access.ts), so a
	// client does not get to claim one. Curated answers have their own
	// admin path (createPolicyEntry).
	if (args.sourceType !== 'manual') {
		throwInvalidInput('Knowledge entries created by hand have the source Manual.');
	}
	// A thread link makes the entry Team Inbox-derived (inbox/access.ts), so
	// only a reader may set one.
	if (args.threadId !== undefined && !isSharedInboxReader(session)) {
		throwForbidden('Linking knowledge to a Team Inbox thread requires Team Inbox access');
	}

	const now = Date.now();

	const entry = {
		entryType: args.entryType,
		title: args.title,
		content: args.content,
		sourceType: args.sourceType,
		sourceId: args.sourceId,
		contactIds: args.contactIds,
		threadId: args.threadId,
		// Stamped on every write of this release (knowledge/entryDedupe.ts):
		// a manual entry is member-visible unless a thread link keeps it to
		// Team Inbox readers.
		memberAccess: args.threadId === undefined ? ('members' as const) : ('restricted' as const),
		embedding: [], // Will be populated by extraction pipeline
		confidence: args.confidence ?? 0.8,
		lastValidatedAt: now,
		expiresAt: args.expiresAt,
		tags: args.tags,
		searchableText: `${args.title} ${args.content}`,
		createdAt: now,
		updatedAt: now,
	};
	const entryId = await ctx.db.insert('knowledgeEntries', entry);

	// Mirror contactIds into the index-able junction (powers getByContact).
	await insertEntryContacts(ctx, entryId, args.contactIds, commitmentFacetsOf(entry));
	// A new embedding input: a local embedder embeds it now.
	await noteCorpusInsert(ctx, 'knowledgeEntries', entryId);

	return entryId;
}

/** The args of `knowledge.graph.updateEntry`. */
export const updateEntryArgs = {
	entryId: v.id('knowledgeEntries'),
	...optionalFields(
		pick(knowledgeEntriesFields, [
			'entryType',
			'title',
			'content',
			'sourceType',
			'contactIds',
			'confidence',
			'tags',
			'expiresAt',
		])
	),
};

/** `knowledge.graph.updateEntry`: edit the user-authored fields of an entry. */
export async function updateEntryHandler(
	ctx: MutationCtx,
	args: ObjectType<typeof updateEntryArgs>,
	session: MutationSessionContext
) {
	const entry = await loadWritableEntry(ctx, session, args.entryId);
	if (!entry) return null;
	requireCuratedWriter(session, entry);
	// The source records where an entry came from, and decides whether it is
	// Team Inbox-derived (inbox/access.ts); an edit cannot rewrite it.
	if (args.sourceType !== undefined && args.sourceType !== entry.sourceType) {
		throwInvalidInput('The source of a knowledge entry cannot be changed.');
	}

	const now = Date.now();
	const patch: Partial<Doc<'knowledgeEntries'>> = {
		updatedAt: now,
		lastValidatedAt: now,
	};
	if (args.entryType !== undefined) {
		patch.entryType = args.entryType;
		// The space-and-type vector filter key follows the type.
		Object.assign(patch, entryKeysForType(entry, args.entryType));
	}
	if (args.title !== undefined) patch.title = args.title;
	if (args.content !== undefined) patch.content = args.content;
	if (args.contactIds !== undefined) patch.contactIds = args.contactIds;
	if (args.confidence !== undefined) patch.confidence = args.confidence;
	if (args.tags !== undefined) patch.tags = args.tags;
	if (args.expiresAt !== undefined) patch.expiresAt = args.expiresAt;

	// Recompute the FTS searchField from the (possibly new) title + content so
	// the edit stays findable via `search` / `ftsRankedIds`.
	const nextTitle = args.title ?? entry.title;
	const nextContent = args.content ?? entry.content;
	patch.searchableText = `${nextTitle} ${nextContent}`;

	// Through the one corpus writer: an edited title or content
	// clears every vector column, and an edit that changes eligibility (an
	// expired entry revived) marks a staged rebuild; either way a local
	// embedder re-embeds the entry.
	await patchCorpusRow(ctx, 'knowledgeEntries', entry, patch);

	// Reconcile the index-able junction when contactIds is edited in place;
	// otherwise re-project its open-commitment facets (type / expiry edits).
	const next = { ...entry, ...patch };
	if (args.contactIds !== undefined) {
		await syncEntryContacts(ctx, args.entryId, args.contactIds, commitmentFacetsOf(next));
	} else {
		await syncCommitmentFacets(ctx, args.entryId, next);
	}

	// Return the edited id (a non-undefined success sentinel) so the web
	// `useBackendOperation` caller can tell a void success from the `undefined`
	// it returns on failure — otherwise the edit modal never closes.
	return args.entryId;
}

/**
 * The args of `knowledge.graph.saveEntry`. `contentHash` (computed by the
 * 'use node' extraction action) enables the cross-source write-dedup leg of
 * the handler and the deterministic linker's exact-dup lookups.
 */
export const saveEntryArgs = {
	...pick(knowledgeEntriesFields, [
		'entryType',
		'title',
		'content',
		'sourceType',
		'sourceId',
		'contactIds',
		'threadId',
		'embedding',
		'embeddingModel',
		'embeddingGeneratedAt',
		'confidence',
		'tags',
		'expiresAt',
		'contentHash',
	]),
	// The space the job measured for `embedding`; the vector is stamped with it,
	// or dropped when the configuration moved on (vectorFieldsForCommit).
	// Optional for previous-release jobs, whose vector is dropped; required
	// after release N+1.
	embeddingSpace: v.optional(measuredEmbeddingSpaceValidator),
};

/** `knowledge.graph.saveEntry`: save an entry from the agent pipeline. */
export async function saveEntryHandler(
	ctx: MutationCtx,
	{ embeddingSpace, ...args }: ObjectType<typeof saveEntryArgs>
) {
	const now = Date.now();
	// Write-level idempotency (knowledge/entryDedupe.ts): an entry from the
	// same source with this title, or one with the same normalized content
	// under the same contact scope, is returned instead of a duplicate. The
	// extraction asks the same question before it embeds; this check in
	// the transaction is what closes the race between two extractions of one
	// source: the second writer's reads conflict with the first's committed
	// insert under Convex OCC, so it sees it here and no-ops. The duplicate
	// already carries its junction rows, so none are written.
	//
	// Who may see it comes from the source, resolved here in the write
	// (entryDedupe.ts `resolveMemberAccess`), never from the caller: an
	// extraction from a previous release passes nothing.
	const memberAccess = await resolveMemberAccess(ctx, args);
	const dup = await findDuplicateEntry(ctx, { ...args, memberAccess });
	if (dup) {
		if (dup.needsRestriction) await ctx.db.patch(dup.id, { memberAccess: 'restricted' });
		return dup.id;
	}
	const { embedding, embeddingModel: _model, embeddingGeneratedAt: _at, ...fields } = args;
	const { isStale, fields: vector } = await vectorFieldsForCommit(
		ctx,
		{ embedding, space: embeddingSpace },
		{ entryType: args.entryType }
	);
	if (isStale) logInfo('[knowledge.saveEntry] stale embedding space, stored without vector');
	const entry = {
		...fields,
		memberAccess,
		...(vector as { embedding: number[] }),
		searchableText: `${args.title} ${args.content}`,
		lastValidatedAt: now,
		createdAt: now,
		updatedAt: now,
	};
	const entryId = await ctx.db.insert('knowledgeEntries', entry);
	// A new row: a staged rebuild learns it may lack its vector.
	await noteCorpusInsert(ctx, 'knowledgeEntries', entryId);

	// Mirror contactIds into the index-able junction (powers getByContact).
	await insertEntryContacts(ctx, entryId, args.contactIds, commitmentFacetsOf(entry));

	return entryId;
}

/** The args of `knowledge.graph.setCommitmentStatus`. */
export const setCommitmentStatusArgs = {
	entryId: v.id('knowledgeEntries'),
	commitmentStatus: commitmentStatusValidator,
	dueAt: v.optional(v.number()),
};

/** `knowledge.graph.setCommitmentStatus`: set the lifecycle status of a commitment. */
export async function setCommitmentStatusHandler(
	ctx: MutationCtx,
	args: ObjectType<typeof setCommitmentStatusArgs>,
	session: MutationSessionContext
) {
	const entry = await loadWritableEntry(ctx, session, args.entryId);
	if (!entry) return null;

	const now = Date.now();
	const patch: Partial<Doc<'knowledgeEntries'>> = {
		commitmentStatus: args.commitmentStatus,
		updatedAt: now,
		lastValidatedAt: now,
	};
	if (args.dueAt !== undefined) patch.dueAt = args.dueAt;
	await ctx.db.patch(args.entryId, patch);
	// Same transaction: the open-commitments index never disagrees with the status.
	await syncCommitmentFacets(ctx, args.entryId, { ...entry, ...patch });
	return args.entryId;
}

/** The args of `knowledge.graph.recordAccess`. */
export const recordAccessArgs = {
	ids: v.array(v.id('knowledgeEntries')),
};

/** `knowledge.graph.recordAccess`: count a recall hit on each entry. */
export async function recordAccessHandler(
	ctx: MutationCtx,
	args: ObjectType<typeof recordAccessArgs>
) {
	const now = Date.now();
	for (const id of args.ids) {
		const entry = await ctx.db.get(id);
		if (!entry) continue;
		await ctx.db.patch(id, {
			accessCount: (entry.accessCount ?? 0) + 1,
			lastAccessedAt: now,
		});
	}
}
