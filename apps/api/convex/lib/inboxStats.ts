import type { MutationCtx } from '../_generated/server';
import { readInstanceCounter, writeInstanceCounter } from './instanceCounters';
import { getInstanceSettings } from './instanceSettings';

/**
 * Inbox processing-status bucket. Maps the wider `processingStatus`
 * literal union into the counter fields of `inboxStats` on the `inbox` row of
 * `instanceCounters` (plan 2.4; formerly on `instanceSettings`);
 * `security_check`, `classifying`, `drafting`, and `awaiting_clarification`
 * collapse to the single `processing` bucket because that's what the dashboard
 * surfaces (the pipeline sub-stages aren't separately interesting to the
 * operator).
 */
type InboxBucket =
	| 'received'
	| 'processing'
	| 'draftReady'
	| 'approved'
	| 'sent'
	| 'quarantined'
	| 'failed'
	| 'rejected'
	| 'archived'
	| 'informational';

/**
 * Map a raw `inboundMessages.processingStatus` value to its dashboard
 * bucket. Returns `null` for unknown status strings — callers should
 * treat that as a no-op so an unknown literal in the schema doesn't
 * silently corrupt the counters.
 */
export function bucketForStatus(status: string): InboxBucket | null {
	switch (status) {
		case 'received':
			return 'received';
		case 'security_check':
		case 'classifying':
		case 'drafting':
		case 'awaiting_clarification':
			return 'processing';
		case 'draft_ready':
			return 'draftReady';
		case 'approved':
			return 'approved';
		case 'sent':
			return 'sent';
		case 'quarantined':
			return 'quarantined';
		case 'failed':
			return 'failed';
		case 'rejected':
			return 'rejected';
		case 'archived':
			return 'archived';
		case 'informational':
			return 'informational';
		default:
			return null;
	}
}

const EMPTY_STATS = {
	received: 0,
	processing: 0,
	draftReady: 0,
	approved: 0,
	sent: 0,
	quarantined: 0,
	failed: 0,
	rejected: 0,
	archived: 0,
	informational: 0,
	total: 0,
} as const;

/**
 * The counters are maintained only once the instance exists (as they were when
 * they lived on the `instanceSettings` row, which the first delta needed).
 */
async function loadInboxCounters(ctx: MutationCtx) {
	if (!(await getInstanceSettings(ctx.db))) return null;
	return await readInstanceCounter(ctx.db, 'inbox');
}

/**
 * Apply a delta to the inbox status counters on the `inbox` counter row. `from === null` is the insert path (no
 * predecessor bucket); `to === null` is the delete path (no successor).
 * `total` is bumped only on insert and decremented only on delete —
 * status transitions move between buckets without changing the lifetime
 * total.
 */
export async function applyInboxStatsDelta(
	ctx: MutationCtx,
	from: InboxBucket | null,
	to: InboxBucket | null
): Promise<void> {
	if (from === to) return; // no-op self-transition
	const counters = await loadInboxCounters(ctx);
	if (!counters) return;
	const current = { ...EMPTY_STATS, ...counters.inboxStats };
	const next = { ...current };
	if (from !== null) next[from] = Math.max(0, next[from] - 1);
	if (to !== null) next[to] = next[to] + 1;
	if (from === null && to !== null) next.total = next.total + 1;
	if (from !== null && to === null) next.total = Math.max(0, next.total - 1);
	await writeInstanceCounter(ctx, 'inbox', { inboxStats: next });
}

/**
 * Apply a signed delta to the denormalized open-thread counter on the `inbox`
 * counter row. `+1` when a thread enters the 'open'
 * status (create-as-open or non-open → open), `-1` when it leaves
 * ('open' → non-open). Clamped at 0. Called by every create-as-open /
 * status-transition path (the Conversation thread module plus the manual
 * outbound-channel thread opener in `unifiedMessages.resolveOutboundThread`);
 * `getInboundStats` reads the result instead of collecting the whole
 * open-thread set per subscriber.
 */
export async function applyOpenThreadDelta(ctx: MutationCtx, delta: 1 | -1): Promise<void> {
	const counters = await loadInboxCounters(ctx);
	if (!counters) return;
	await writeInstanceCounter(ctx, 'inbox', {
		openThreads: Math.max(0, (counters.openThreads ?? 0) + delta),
	});
}
