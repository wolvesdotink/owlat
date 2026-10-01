/**
 * Open-commitment projection on the knowledge ↔ contact junction (issue #919).
 *
 * The agent's context step asks, for every contact-linked inbound, "which
 * promises do we still owe this contact?". Answering that from the entries
 * themselves meant loading every knowledge entry linked to the contact (each
 * with its 1,536-number embedding) to return at most ten. Instead each
 * `knowledgeEntryContacts` row carries the few facets the recall needs
 * (schema/knowledgeCommitmentFacets.ts), and the reader walks the
 * `by_contact_open_commitment` index in due order, loading only the entries it
 * returns.
 *
 * Writers keep the facets in step with the parent entry:
 *   - a junction row is written with them (graph.ts insert/sync helpers);
 *   - an edit to entry type, commitment status, due date or expiry re-projects
 *     the entry's rows (`syncCommitmentFacets`);
 *   - a dedup merge re-parents a loser's row with the survivor's facets
 *     (maintenance.ts); a contact merge only changes `contactId`, so the facets,
 *     which describe the entry, stay valid;
 *   - erasure, expiry and delete remove the rows.
 * Rows written before this change have no facets; the reader hydrates them the
 * old way until migration 0052 has projected them.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { COMMITMENT_ENTRY_TYPES, isCommitmentOpen } from '../schema/knowledge';
import { logWarn } from '../lib/runtimeLog';
import { batchGet } from '../_utils/batchLoader';

/** Due key of an undated commitment: after every real due date. */
export const UNDATED_DUE_KEY = Number.MAX_VALUE;

/**
 * Most open-commitment junction rows one recall walks before giving up. Only
 * expired rows the decay cron has not reaped yet (or rows whose entry drifted)
 * are skipped, so a healthy walk reads `limit` rows; the cap keeps a backlog of
 * expired promises from turning into an unbounded read.
 */
export const OPEN_COMMITMENT_SCAN_BUDGET = 500;

type FacetSource = Pick<
	Doc<'knowledgeEntries'>,
	'entryType' | 'commitmentStatus' | 'dueAt' | 'createdAt' | 'expiresAt'
>;

export type CommitmentFacets = {
	isOpenCommitment: boolean;
	commitmentDueKey: number | undefined;
	commitmentOrderKey: number | undefined;
	entryExpiresAt: number | undefined;
};

const COMMITMENT_TYPES: ReadonlySet<string> = new Set(COMMITMENT_ENTRY_TYPES);

/** A `decision` / `action_item` that is not fulfilled or cancelled (TTL aside). */
export function isOpenCommitmentEntry(entry: FacetSource): boolean {
	return COMMITMENT_TYPES.has(entry.entryType) && isCommitmentOpen(entry.commitmentStatus);
}

/** The junction facets for an entry. Sort/TTL keys are only set on open rows. */
export function commitmentFacetsOf(entry: FacetSource): CommitmentFacets {
	if (!isOpenCommitmentEntry(entry)) {
		return {
			isOpenCommitment: false,
			commitmentDueKey: undefined,
			commitmentOrderKey: undefined,
			entryExpiresAt: undefined,
		};
	}
	return {
		isOpenCommitment: true,
		commitmentDueKey: entry.dueAt ?? UNDATED_DUE_KEY,
		commitmentOrderKey: -entry.createdAt,
		entryExpiresAt: entry.expiresAt,
	};
}

function sameFacets(row: Doc<'knowledgeEntryContacts'>, facets: CommitmentFacets): boolean {
	return (
		row.isOpenCommitment === facets.isOpenCommitment &&
		row.commitmentDueKey === facets.commitmentDueKey &&
		row.commitmentOrderKey === facets.commitmentOrderKey &&
		row.entryExpiresAt === facets.entryExpiresAt
	);
}

/**
 * Re-project every junction row of one entry after an edit that may change its
 * facets. `entry` is the entry as it now stands (after the caller's patch).
 * Rows already carrying the right facets are not rewritten.
 */
export async function syncCommitmentFacets(
	ctx: MutationCtx,
	entryId: Id<'knowledgeEntries'>,
	entry: FacetSource
): Promise<void> {
	const facets = commitmentFacetsOf(entry);
	const rows = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_entry', (q) => q.eq('entryId', entryId))
		.collect(); // bounded: junction rows for one entry (contacts per entry)
	for (const row of rows) {
		if (!sameFacets(row, facets)) await ctx.db.patch(row._id, facets);
	}
}

/**
 * What the open-commitments recall returns: the entry without its embedding
 * or other retrieval-only fields. A subset of the full document, so a caller
 * written against `Doc<'knowledgeEntries'>` keeps reading the same fields.
 */
export type OpenCommitment = Pick<
	Doc<'knowledgeEntries'>,
	| '_id'
	| '_creationTime'
	| 'entryType'
	| 'title'
	| 'content'
	| 'commitmentStatus'
	| 'dueAt'
	| 'createdAt'
	| 'expiresAt'
>;

function toOpenCommitment(entry: Doc<'knowledgeEntries'>): OpenCommitment {
	return {
		_id: entry._id,
		_creationTime: entry._creationTime,
		entryType: entry.entryType,
		title: entry.title,
		content: entry.content,
		commitmentStatus: entry.commitmentStatus,
		dueAt: entry.dueAt,
		createdAt: entry.createdAt,
		expiresAt: entry.expiresAt,
	};
}

function isLive(entry: FacetSource, now: number): boolean {
	return !(entry.expiresAt !== undefined && entry.expiresAt < now);
}

/** Soonest due first, undated last, then newest first. */
function compareOpenCommitments(a: OpenCommitment, b: OpenCommitment): number {
	const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
	const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
	if (aDue !== bDue) return aDue - bDue;
	return b.createdAt - a.createdAt;
}

/**
 * The contact's open, unexpired commitments, soonest due first (undated last),
 * newest first on ties, at most `limit`.
 *
 * Two legs, merged:
 *   1. projected rows, walked in index order: an expired row is skipped from
 *      its own `entryExpiresAt` without loading the entry, and the walk stops
 *      once `limit` entries survived, so entry loads scale with `limit`, not
 *      with the contact's knowledge;
 *   2. rows without facets (written before the projection, until migration
 *      0052 has run): hydrated and filtered as before. Empty once backfilled.
 * Every loaded entry is re-checked against its own fields, so a row whose
 * facets drifted can drop a stale candidate but never return a wrong one.
 */
export async function readOpenCommitments(
	ctx: QueryCtx,
	contactId: Id<'contacts'>,
	limit: number,
	now: number
): Promise<OpenCommitment[]> {
	if (limit <= 0) return [];
	const found = new Map<Id<'knowledgeEntries'>, OpenCommitment>();
	const accept = (entry: Doc<'knowledgeEntries'> | null): boolean => {
		if (!entry || found.has(entry._id)) return false;
		if (!isLive(entry, now) || !isOpenCommitmentEntry(entry)) return false;
		found.set(entry._id, toOpenCommitment(entry));
		return true;
	};

	let accepted = 0;
	let scanned = 0;
	const projected = ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact_open_commitment', (q) =>
			q.eq('contactId', contactId).eq('isOpenCommitment', true)
		);
	for await (const row of projected) {
		if (accepted >= limit) break;
		if (scanned >= OPEN_COMMITMENT_SCAN_BUDGET) {
			logWarn('knowledge.openCommitments.scanBudget', {
				contactId,
				scanned,
				returned: accepted,
			});
			break;
		}
		scanned++;
		if (row.entryExpiresAt !== undefined && row.entryExpiresAt < now) continue;
		if (accept(await ctx.db.get(row.entryId))) accepted++;
	}

	const unprojected = await ctx.db
		.query('knowledgeEntryContacts')
		.withIndex('by_contact_open_commitment', (q) =>
			q.eq('contactId', contactId).eq('isOpenCommitment', undefined)
		)
		.collect(); // bounded: pre-projection rows of one contact; empty once 0052 has run
	const legacy = await batchGet(
		ctx,
		unprojected.map((row) => row.entryId)
	);
	for (const entry of legacy.values()) accept(entry);

	return [...found.values()].sort(compareOpenCommitments).slice(0, limit);
}
