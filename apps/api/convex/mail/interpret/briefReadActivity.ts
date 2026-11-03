/**
 * The activity tail behind `brief.ts get` and the team stream: the newest
 * rows, their sealed payloads opened, the rows a reader never sees dropped,
 * and "since you last looked". No authorization here: the caller has decided
 * the viewer may read the thread.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import type { ActivityView } from './briefShape';
import { isGateRefusalCode } from './retry';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** Activity rows scanned for the tail and for "since you last looked". */
const ACTIVITY_SCAN = 100;
const ACTIVITY_SHOWN = 5;

/** The newest activity rows (newest first), bounded. */
export async function readActivityTail(ctx: ReadCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadActivity')
				.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', ref.id))
				.order('desc')
				.take(ACTIVITY_SCAN)
		: ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', ref.id))
				.order('desc')
				.take(ACTIVITY_SCAN);
}

/** One string field of a row's sealed payload, if the payload holds it. */
async function activityPayloadField(
	row: Doc<'threadActivity'>,
	field: 'text' | 'code'
): Promise<string | undefined> {
	if (!row.payload) return undefined;
	try {
		const parsed: unknown = JSON.parse(await openMessageBody(row.payload));
		if (parsed && typeof parsed === 'object' && field in parsed) {
			const value = (parsed as Record<string, unknown>)[field];
			return typeof value === 'string' ? value : undefined;
		}
	} catch {
		// A payload that does not parse renders without detail.
	}
	return undefined;
}

async function activityText(row: Doc<'threadActivity'>): Promise<string | undefined> {
	return activityPayloadField(row, 'text');
}

/**
 * Whether a row records a run the interpretation gate refused (AI off, no
 * provider, budget used up). That is the instance's state, not an event of
 * the thread, so such a row is never shown: not in the brief's activity, not
 * as a team stream line, not as new since the last look.
 */
export async function isGateRefusalActivity(row: Doc<'threadActivity'>): Promise<boolean> {
	if (row.type !== 'interpretation_incomplete') return false;
	return isGateRefusalCode(await activityPayloadField(row, 'code'));
}

/** The activity rows a reader is shown: {@link isGateRefusalActivity} rows dropped. */
export async function withoutGateRefusals(
	rows: readonly Doc<'threadActivity'>[]
): Promise<Doc<'threadActivity'>[]> {
	const isRefusal = await Promise.all(rows.map(isGateRefusalActivity));
	return rows.filter((_, i) => !isRefusal[i]);
}

/** One activity row as the brief and the team stream show it. */
export async function toActivityView(row: Doc<'threadActivity'>): Promise<ActivityView> {
	const text = await activityText(row);
	return {
		id: row._id,
		seq: row.seq,
		type: row.type,
		actor: row.actor,
		provenance: row.provenance,
		visibility: row.visibility,
		...(row.itemId ? { itemId: row.itemId } : {}),
		...(row.itemRevision !== undefined ? { itemRevision: row.itemRevision } : {}),
		...(row.delta ? { delta: row.delta } : {}),
		...(row.opRef ? { opRef: row.opRef } : {}),
		...(text !== undefined ? { text } : {}),
		eventAt: row.eventAt,
	};
}

/** The latest substance rows as the brief's "Activity" block. */
export async function toActivityViews(
	rows: readonly Doc<'threadActivity'>[]
): Promise<ActivityView[]> {
	const shown = rows.filter((r) => r.visibility === 'substance').slice(0, ACTIVITY_SHOWN);
	return Promise.all(shown.map(toActivityView));
}

/** "Since you last looked", from the activity tail past the viewer's seen seq. Pure. */
export function sinceLastSeenOf(
	rows: readonly Pick<Doc<'threadActivity'>, 'seq' | 'type' | 'itemId' | 'visibility'>[],
	seenActivitySeq: number
) {
	const newItemIds = new Set<Id<'threadItems'>>();
	const changedItemIds = new Set<Id<'threadItems'>>();
	let newActivityCount = 0;
	for (const row of rows) {
		if (row.seq <= seenActivitySeq) continue;
		if (row.visibility === 'substance') newActivityCount++;
		if (!row.itemId) continue;
		if (row.type === 'item_opened') newItemIds.add(row.itemId);
		else if (row.type.startsWith('item_') || row.type === 'proposal_confirmed') {
			changedItemIds.add(row.itemId);
		}
	}
	for (const id of newItemIds) changedItemIds.delete(id);
	return { newItemIds: [...newItemIds], changedItemIds: [...changedItemIds], newActivityCount };
}
