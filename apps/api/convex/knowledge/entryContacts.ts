/**
 * The `knowledgeEntryContacts` junction: the index-able copy of an entry's
 * `contactIds` that `knowledge.graph.getByContact` reads. Every entry write
 * that sets or clears `contactIds` reconciles it in the same transaction.
 */

import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import type { CommitmentFacets } from './commitmentFacets';

/**
 * Write the `knowledgeEntryContacts` junction rows that mirror an entry's
 * `contactIds`. The array lives on the entry for the reads that still want it
 * inline; the junction is the index-able copy `getByContact` queries. Each row
 * carries the entry's open-commitment facets (knowledge/commitmentFacets.ts).
 * Call this right after inserting an entry — the entry is brand-new, so there
 * are no stale junction rows to reconcile. For an in-place edit or teardown use
 * `syncEntryContacts` (delete-then-reinsert) instead.
 */
export async function insertEntryContacts(
	ctx: MutationCtx,
	entryId: Id<'knowledgeEntries'>,
	contactIds: Id<'contacts'>[] | undefined,
	facets: CommitmentFacets
): Promise<void> {
	if (!contactIds) return;
	// De-dup the input so a contactId repeated in the array yields one row.
	for (const contactId of new Set(contactIds)) {
		await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId, ...facets });
	}
}

/**
 * Reconcile the `knowledgeEntryContacts` junction rows for an entry whose
 * `contactIds` may already have rows. Delete-then-reinsert, so it is correct for
 * an in-place `contactIds` edit (`updateEntry`) and teardown
 * (`contactIds = undefined` deletes all rows, used by `deleteEntry`). Mirrors
 * `semanticFiles.ts:syncFileContacts`.
 */
export async function syncEntryContacts(
	ctx: MutationCtx,
	entryId: Id<'knowledgeEntries'>,
	contactIds: Id<'contacts'>[] | undefined,
	facets?: CommitmentFacets
): Promise<void> {
	const existing = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_entry', (q) => q.eq('entryId', entryId))
		.collect(); // bounded: junction rows for one entry (contacts per entry)
	for (const row of existing) await ctx.db.delete(row._id);
	// De-dup so a contactId repeated in the array yields one row.
	for (const contactId of new Set(contactIds ?? [])) {
		await ctx.db.insert('knowledgeEntryContacts', { entryId, contactId, ...facets });
	}
}
