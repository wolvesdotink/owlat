import type { MutationCtx } from '../_generated/server';

/**
 * Inbox processing-status bucket. Maps the wider `processingStatus`
 * literal union (10 values) into the 9 counter fields on
 * `instanceSettings.inboxStats`; `security_check`, `classifying`, and
 * `drafting` collapse to the single `processing` bucket because that's
 * what the dashboard surfaces (the three pipeline sub-stages aren't
 * separately interesting to the operator).
 */
export type InboxBucket =
	| 'received'
	| 'processing'
	| 'draftReady'
	| 'approved'
	| 'sent'
	| 'quarantined'
	| 'failed'
	| 'rejected'
	| 'archived';

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
	total: 0,
} as const;

async function loadSettings(ctx: MutationCtx) {
	return ctx.db.query('instanceSettings').first();
}

/**
 * Apply a delta to the inbox status counters on the singleton
 * `instanceSettings` doc. `from === null` is the insert path (no
 * predecessor bucket); `to === null` is the delete path (no successor).
 * `total` is bumped only on insert and decremented only on delete —
 * status transitions move between buckets without changing the lifetime
 * total.
 */
export async function applyInboxStatsDelta(
	ctx: MutationCtx,
	from: InboxBucket | null,
	to: InboxBucket | null,
): Promise<void> {
	if (from === to) return; // no-op self-transition
	const settings = await loadSettings(ctx);
	if (!settings) return;
	const current = { ...EMPTY_STATS, ...settings.inboxStats };
	const next = { ...current };
	if (from !== null) next[from] = Math.max(0, next[from] - 1);
	if (to !== null) next[to] = next[to] + 1;
	if (from === null && to !== null) next.total = next.total + 1;
	if (from !== null && to === null) next.total = Math.max(0, next.total - 1);
	await ctx.db.patch(settings._id, { inboxStats: next });
}

/**
 * Apply a signed delta to the denormalized open-thread counter on the
 * singleton `instanceSettings` doc. `+1` when a thread enters the 'open'
 * status (create-as-open or non-open → open), `-1` when it leaves
 * ('open' → non-open). Clamped at 0. Called by every create-as-open /
 * status-transition path (the Conversation thread module plus the manual
 * outbound-channel thread opener in `unifiedMessages.resolveOutboundThread`);
 * `getInboundStats` reads the result instead of collecting the whole
 * open-thread set per subscriber.
 */
export async function applyOpenThreadDelta(
	ctx: MutationCtx,
	delta: 1 | -1,
): Promise<void> {
	const settings = await loadSettings(ctx);
	if (!settings) return;
	const current = settings.openThreads ?? 0;
	await ctx.db.patch(settings._id, {
		openThreads: Math.max(0, current + delta),
	});
}
