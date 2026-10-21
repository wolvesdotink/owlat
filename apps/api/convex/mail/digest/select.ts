/**
 * Read on arrival (SPEC §6.5): which threads a digest covers.
 *
 * ELIGIBILITY is per thread and explicit: `mailThreads.digestPendingSince`
 * (set by `refreshArrivalProjection` while the placement is `digest` and the
 * newest inbound message lies past `digestConsumedThrough`). Selection reads
 * that index newest first, at most 200 threads (`take(201)` probes for more),
 * and snapshots each visited thread's boundary: the newest inbound
 * `sourceOrderKey` at selection, which a sent digest consumes through.
 *
 * RENDERED LINES are chosen before generation: per kind (newsletters,
 * updates, promotions, cold outreach) the newest 5 threads, so at most 20
 * lines are summarised. Every other visited thread is counted in `overflowByKind`
 * ("and N more"), exactly when ≤200 were visited, else at least ("200+").
 *
 * Isolate-safe; not a Convex function.
 */

import type { DigestKind } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';

/** Threads one digest visits at most. */
export const DIGEST_MAX_VISITED = 200;
/** Rendered lines per kind. */
export const DIGEST_LINES_PER_KIND = 5;
/** The kinds in the order the email shows them. */
export const DIGEST_KIND_ORDER: readonly DigestKind[] = [
	'newsletter',
	'updates',
	'promotion',
	'cold_outreach',
];

type Digest = Doc<'mailDigests'>;

export interface DigestSelection {
	items: Digest['items'];
	visited: Digest['visited'];
	overflowByKind: Digest['overflowByKind'];
	overflowLabel: Digest['overflowLabel'];
}

/**
 * The digest kind of a thread: Cold outreach when its newest inbound message
 * carries a cold-pitch verdict (#1381, `arrival/coldPitch.ts`), else from its
 * category. Pure.
 */
export function digestKindOf(category: string | undefined, isColdPitch = false): DigestKind {
	if (isColdPitch) return 'cold_outreach';
	if (category === 'newsletter') return 'newsletter';
	if (category === 'promotion') return 'promotion';
	return 'updates';
}

/** A zero count per digest kind. Pure. */
function emptyCounts(): Record<DigestKind, number> {
	return { newsletter: 0, updates: 0, promotion: 0, cold_outreach: 0 };
}

/** One candidate thread, newest first. */
export interface DigestCandidate {
	threadId: Id<'mailThreads'>;
	messageId: Id<'mailMessages'>;
	throughSourceOrderKey: string;
	kind: DigestKind;
}

/**
 * Split candidates (newest first, ≤201 read) into the rendered lines, the
 * visited set and the per-kind overflow. Pure.
 */
export function selectDigest(candidates: readonly DigestCandidate[]): DigestSelection {
	const isTruncated = candidates.length > DIGEST_MAX_VISITED;
	const visitedCandidates = candidates.slice(0, DIGEST_MAX_VISITED);
	const perKind = emptyCounts();
	const overflowByKind = emptyCounts();
	const items: Digest['items'] = [];
	for (const candidate of visitedCandidates) {
		if (perKind[candidate.kind] < DIGEST_LINES_PER_KIND) {
			perKind[candidate.kind] += 1;
			items.push({
				threadId: candidate.threadId,
				messageId: candidate.messageId,
				kind: candidate.kind,
			});
		} else {
			overflowByKind[candidate.kind] += 1;
		}
	}
	return {
		items,
		visited: visitedCandidates.map((candidate) => ({
			threadId: candidate.threadId,
			throughSourceOrderKey: candidate.throughSourceOrderKey,
			kind: candidate.kind,
		})),
		overflowByKind,
		overflowLabel: isTruncated ? 'at_least' : 'exact',
	};
}

/** The mailbox's digest-pending threads, newest first, as candidates (≤201 read). */
export async function readDigestCandidates(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>
): Promise<DigestCandidate[]> {
	const threads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_digest_pending', (q) =>
			q.eq('mailboxId', mailboxId).gte('digestPendingSince', 0)
		)
		.order('desc')
		.take(DIGEST_MAX_VISITED + 1);
	const candidates: DigestCandidate[] = [];
	for (const thread of threads) {
		if (!thread.arrival) continue;
		candidates.push({
			threadId: thread._id,
			messageId: thread.arrival.messageId,
			throughSourceOrderKey: thread.arrival.sourceOrderKey ?? '',
			kind: digestKindOf(thread.category?.label, thread.arrival.isColdPitch === true),
		});
	}
	return candidates;
}

/** Whether the mailbox has anything for a digest (one indexed read). */
export async function hasDigestPending(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>
): Promise<boolean> {
	const first = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_digest_pending', (q) =>
			q.eq('mailboxId', mailboxId).gte('digestPendingSince', 0)
		)
		.first();
	return first !== null;
}
