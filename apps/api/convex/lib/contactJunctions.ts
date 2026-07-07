import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * Contact-junction cascade helpers — the single owner of the "junction row and
 * its parent's mirrored `contactIds` array must stay in sync" invariant.
 *
 * The two contact junctions (`knowledgeEntryContacts` → `knowledgeEntries`,
 * `semanticFileContacts` → `semanticFiles`) are each the index-able mirror of a
 * `contactIds` array on the parent row. Repointing or detaching one of them MUST
 * also rewrite that parent array or the two silently drift — a previously-flagged
 * hazard that was open-coded ~3× across the merge and delete cascades. These two
 * helpers own that invariant so it is written once. Both junctions share the
 * `by_contact` index and a `contactId` column; the per-junction parent table +
 * FK column + mirror array vary, so a spec object carries them.
 */
type JunctionTableName = 'knowledgeEntryContacts' | 'semanticFileContacts';
type JunctionParentTable = 'knowledgeEntries' | 'semanticFiles';

export type ContactJunctionSpec = {
	/** Junction table that carries `(parentIdField, contactId)` rows. */
	junctionTable: JunctionTableName;
	/** Parent table the junction's `parentIdField` points at. */
	parentTable: JunctionParentTable;
	/** Junction column holding the parent FK (e.g. `entryId`, `fileId`). */
	parentIdField: 'entryId' | 'fileId';
	/** Parent column mirroring the junction as an array (always `contactIds`). */
	mirrorField: 'contactIds';
};

/** Read every junction row for one contact via the shared `by_contact` index. */
function junctionLinksForContact(
	ctx: MutationCtx,
	junctionTable: JunctionTableName,
	contactId: Id<'contacts'>
): Promise<
	Array<{
		_id: Id<JunctionTableName>;
		entryId?: Id<'knowledgeEntries'>;
		fileId?: Id<'semanticFiles'>;
	}>
> {
	return ctx.db
		.query(junctionTable)
		.withIndex('by_contact', (q) => q.eq('contactId', contactId))
		.collect(); // bounded: one contact's junction rows
}

/** Strip / rewrite a contact id in a parent row's mirrored `contactIds` array. */
async function rewriteMirrorArray(
	ctx: MutationCtx,
	spec: ContactJunctionSpec,
	parentId: Id<JunctionParentTable>,
	rewrite: (ids: Id<'contacts'>[] | undefined) => Id<'contacts'>[] | undefined
): Promise<void> {
	const parent = (await ctx.db.get(parentId)) as { contactIds?: Id<'contacts'>[] } | null;
	if (!parent) return;
	await ctx.db.patch(parentId, { [spec.mirrorField]: rewrite(parent.contactIds) });
}

/**
 * Repoint every junction row from `sourceContactId` onto `targetContactId`,
 * deduping a `(parent, contact)` pair the target already holds, and keep the
 * parent's mirrored `contactIds` array in lock-step with the junction:
 *   - already-linked → drop the redundant source row AND strip the source id
 *     from the parent array;
 *   - otherwise       → repoint the row AND rewrite the source id to the target
 *     in the parent array.
 * The merge cascade's array-mirror invariant, written once.
 */
export async function repointContactJunction(
	ctx: MutationCtx,
	spec: ContactJunctionSpec,
	targetContactId: Id<'contacts'>,
	sourceContactId: Id<'contacts'>
): Promise<void> {
	const targetLinks = await junctionLinksForContact(ctx, spec.junctionTable, targetContactId);
	const targetParentIds = new Set(targetLinks.map((l) => l[spec.parentIdField] as string));
	const sourceLinks = await junctionLinksForContact(ctx, spec.junctionTable, sourceContactId);
	for (const link of sourceLinks) {
		const parentId = link[spec.parentIdField] as Id<JunctionParentTable>;
		if (targetParentIds.has(parentId as string)) {
			// Target already linked to this parent — drop the redundant source row
			// and strip the source from the parent's mirror array.
			await ctx.db.delete(link._id);
			await rewriteMirrorArray(ctx, spec, parentId, (ids) =>
				ids?.filter((c) => c !== sourceContactId)
			);
		} else {
			await ctx.db.patch(link._id, { contactId: targetContactId });
			targetParentIds.add(parentId as string);
			await rewriteMirrorArray(ctx, spec, parentId, (ids) =>
				ids?.map((c) => (c === sourceContactId ? targetContactId : c))
			);
		}
	}
}

/**
 * Detach every junction row for `contactId` and strip that id from the parent's
 * mirrored `contactIds` array. Does NOT delete the parent — the caller decides
 * whether an orphaned parent is torn down (knowledge) or kept (org files). The
 * delete cascade's array-mirror invariant, written once.
 */
export async function detachContactJunction(
	ctx: MutationCtx,
	spec: ContactJunctionSpec,
	contactId: Id<'contacts'>
): Promise<void> {
	const links = await junctionLinksForContact(ctx, spec.junctionTable, contactId);
	for (const link of links) {
		const parentId = link[spec.parentIdField] as Id<JunctionParentTable>;
		await ctx.db.delete(link._id);
		await rewriteMirrorArray(ctx, spec, parentId, (ids) => ids?.filter((c) => c !== contactId));
	}
}

export const KNOWLEDGE_ENTRY_JUNCTION: ContactJunctionSpec = {
	junctionTable: 'knowledgeEntryContacts',
	parentTable: 'knowledgeEntries',
	parentIdField: 'entryId',
	mirrorField: 'contactIds',
};

export const SEMANTIC_FILE_JUNCTION: ContactJunctionSpec = {
	junctionTable: 'semanticFileContacts',
	parentTable: 'semanticFiles',
	parentIdField: 'fileId',
	mirrorField: 'contactIds',
};
