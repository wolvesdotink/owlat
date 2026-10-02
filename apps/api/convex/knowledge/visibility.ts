/**
 * Who may read and write the knowledge graph: the `ai.knowledge` feature floor
 * for writes, the viewer a soft-auth read resolves to, the shared-inbox reader
 * rule for entries derived from Team Inbox mail (inbox/access.ts), and the
 * page clamps every list read applies.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { authedMutation, adminMutation, featureGated } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { isInboxDerivedKnowledge, isSharedInboxReader } from '../inbox/access';

// ============================================================
// Feature floor and reader rule
// ============================================================

/**
 * The knowledge graph's write builders: the `ai.knowledge` floor composed onto
 * the member and admin builders, so no write reaches the graph while the
 * feature is off. The soft-auth reads keep the flag inside
 * `resolveKnowledgeViewer` instead, because they return empty rather than
 * throw.
 */
export const knowledgeMutation = featureGated(authedMutation, 'ai.knowledge');
export const knowledgeAdminMutation = featureGated(adminMutation, 'ai.knowledge');

/** What a soft-auth knowledge read may show the caller. */
export interface KnowledgeViewer {
	/** Whether entries derived from Team Inbox mail are visible (inbox/access.ts). */
	canReadInbox: boolean;
}

/**
 * Resolve the caller of a soft-auth knowledge read. `null` means the caller
 * gets nothing: the `ai.knowledge` flag is off, or the caller is anonymous or
 * not an active member. Otherwise `canReadInbox` applies the shared-inbox
 * reader rule to entries derived from Team Inbox mail.
 */
export async function resolveKnowledgeViewer(ctx: QueryCtx): Promise<KnowledgeViewer | null> {
	if (!(await isFeatureEnabled(ctx, 'ai.knowledge'))) return null;
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session?.role) return null;
	return { canReadInbox: isSharedInboxReader(session) };
}

/** Whether `entry` is visible to a caller whose reader status is `canReadInbox`. */
export function isKnowledgeEntryVisible(
	canReadInbox: boolean,
	entry: Pick<Doc<'knowledgeEntries'>, 'sourceType' | 'threadId'>
): boolean {
	return canReadInbox || !isInboxDerivedKnowledge(entry);
}

/**
 * Largest page a knowledge read returns, whatever the client asks for. Every
 * entry carries a 1536-float embedding, so an unclamped `limit` could read
 * the whole table in one query.
 */
const MAX_KNOWLEDGE_PAGE = 100;

/** A client `limit`, defaulted and clamped into [1, MAX_KNOWLEDGE_PAGE]. */
export function pageLimit(limit: number | undefined, fallback: number): number {
	const requested = Number.isFinite(limit) ? Math.floor(limit as number) : fallback;
	return Math.min(Math.max(requested, 1), MAX_KNOWLEDGE_PAGE);
}

/**
 * Largest number of rows a list read scans to fill a page for a caller who
 * cannot see Team Inbox-derived entries. Entries carry a 1536-float embedding,
 * so an unbounded skip-and-continue scan over an inbox-heavy graph would hit
 * the query read limit; bounded, the page may come back short instead.
 */
const HIDDEN_ENTRY_SCAN_CAP = 250;

/**
 * Take up to `limit` entries from `query` that the caller may see. A reader
 * reads exactly `limit` rows, as before; anyone else scans up to four times
 * the page (bounded by HIDDEN_ENTRY_SCAN_CAP, never below `limit`) and keeps
 * the visible ones.
 */
export async function takeVisibleEntries(
	query: { take(n: number): Promise<Doc<'knowledgeEntries'>[]> },
	canReadInbox: boolean,
	limit: number
): Promise<Doc<'knowledgeEntries'>[]> {
	if (canReadInbox) return await query.take(limit);
	const scan = Math.max(limit, Math.min(limit * 4, HIDDEN_ENTRY_SCAN_CAP));
	const rows = await query.take(scan);
	return rows.filter((row) => isKnowledgeEntryVisible(false, row)).slice(0, limit);
}

/**
 * Load an entry for a write, or `null` when it is missing or derived from Team
 * Inbox mail the caller cannot read. The write then behaves exactly as it does
 * for a missing id, so a hidden entry is neither changed nor confirmed.
 */
export async function loadWritableEntry(
	ctx: MutationCtx,
	session: MutationSessionContext,
	entryId: Id<'knowledgeEntries'>
): Promise<Doc<'knowledgeEntries'> | null> {
	const entry = await ctx.db.get(entryId);
	if (!entry || !isKnowledgeEntryVisible(isSharedInboxReader(session), entry)) return null;
	return entry;
}
