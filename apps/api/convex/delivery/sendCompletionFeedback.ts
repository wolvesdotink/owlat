import type { Infer } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { countableSendRefValidator } from '../lib/validators/send';
import type { parkedFeedbackTransitionValidator } from '../schema/sendCompletionFailures';

// ============================================================================
// Provider feedback parked on a recorded send completion (#1195).
//
// A Send whose completion threw stays `queued` until the record replays, and
// the lifecycle refuses terminal provider feedback against `queued`. The two
// provider-id entry points of the Send lifecycle park such an event on the
// record instead of dropping it; the replay applies the parked events right
// after the completion (`./sendCompletionFailures`).
//
// ONE SLOT PER KIND, SO NOTHING TERMINAL IS EVER DROPPED. A provider can report
// a soft bounce every retry for days; a list would fill and push out the hard
// bounce that follows. Instead each kind has one slot and a fixed rule for which
// report it keeps:
//   - hard bounce, complaint, delivery: the EARLIEST. Each is terminal or
//     one-shot evidence, and the lifecycle would treat a later repeat as a
//     duplicate anyway.
//   - soft bounce, provider failure: the LATEST. A repeated soft bounce only
//     bumps a counter the lifecycle keeps per Send, and that counter loses the
//     repeats here: the coalescing is the price of a bounded buffer. A soft
//     bounce still hardens if a hard bounce is parked beside it.
// At most five events, and every kind the lifecycle can act on is kept.
//
// REPLAYED IN PROVIDER-TIME ORDER. Arrival order is not event order: a
// complaint stamped after a soft bounce can reach us first. `orderParkedFeedback`
// sorts by the provider's `at`, then by arrival, then by a fixed kind order.
// ============================================================================

type CountableSendRef = Infer<typeof countableSendRefValidator>;
export type ParkedTransition = Infer<typeof parkedFeedbackTransitionValidator>;
export interface ParkedEvent {
	transition: ParkedTransition;
	receivedAt: number;
}
type FailureRow = Doc<'sendCompletionFailures'>;

type Slot = 'bounced:hard' | 'bounced:soft' | 'complained' | 'delivered' | 'failed';
const SLOT_ORDER: readonly Slot[] = [
	'delivered',
	'bounced:soft',
	'bounced:hard',
	'complained',
	'failed',
];
const KEEPS_LATEST: ReadonlySet<Slot> = new Set(['bounced:soft', 'failed']);

function slotOf(transition: ParkedTransition): Slot {
	return transition.to === 'bounced' ? `bounced:${transition.bounceType}` : transition.to;
}

export function isParkable(transition: { to: string }): transition is ParkedTransition {
	return (
		transition.to === 'bounced' ||
		transition.to === 'complained' ||
		transition.to === 'delivered' ||
		transition.to === 'failed'
	);
}

/** Put an event in its kind's slot. Pure; returns the new list, or null when nothing changes. */
export function coalesceParkedFeedback(
	parked: readonly ParkedEvent[],
	incoming: ParkedEvent
): ParkedEvent[] | null {
	const slot = slotOf(incoming.transition);
	const current = parked.find((event) => slotOf(event.transition) === slot);
	if (current) {
		const isNewer = incoming.transition.at > current.transition.at;
		const isOlder = incoming.transition.at < current.transition.at;
		if (!(KEEPS_LATEST.has(slot) ? isNewer : isOlder)) return null;
	}
	return [...parked.filter((event) => slotOf(event.transition) !== slot), incoming];
}

/** Provider time, then arrival, then the fixed kind order. Pure. */
export function orderParkedFeedback(parked: readonly ParkedEvent[]): ParkedEvent[] {
	return [...parked].sort(
		(a, b) =>
			a.transition.at - b.transition.at ||
			a.receivedAt - b.receivedAt ||
			SLOT_ORDER.indexOf(slotOf(a.transition)) - SLOT_ORDER.indexOf(slotOf(b.transition))
	);
}

/** The open and exhausted records of one Send, through `by_send_and_status`. */
export async function unresolvedCompletionFailures(
	ctx: MutationCtx,
	sendId: CountableSendRef['id']
): Promise<FailureRow[]> {
	const rows: FailureRow[] = [];
	for (const status of ['open', 'exhausted'] as const) {
		rows.push(
			...(await ctx.db
				.query('sendCompletionFailures')
				.withIndex('by_send_and_status', (q) => q.eq('sendRef.id', sendId).eq('status', status))
				.take(10))
		);
	}
	return rows;
}

/**
 * Keep a provider event the lifecycle just refused because the Send is still
 * `queued` behind an unrecorded completion. Returns whether the event is held.
 *
 * WHY PARK INSTEAD OF ANSWERING 5xx. A retryable answer would ask the provider
 * to hold the event for us, and providers differ: SNS gives an HTTP endpoint a
 * few retries over minutes, while a fix may take a day; Mandrill and Svix batch
 * several events in one delivery, so the whole batch would come back and the
 * non-idempotent opens and clicks in it would count twice. Parking keeps the
 * event in our own database for exactly as long as the record lives.
 */
export async function parkFeedbackOnRecordedCompletion(
	ctx: MutationCtx,
	sendRef: CountableSendRef,
	transition: { to: string }
): Promise<boolean> {
	if (!isParkable(transition)) return false;
	const send = await ctx.db.get(sendRef.id);
	if (send?.status !== 'queued') return false;
	const row = (await unresolvedCompletionFailures(ctx, sendRef.id))[0];
	if (!row) return false;
	const next = coalesceParkedFeedback(row.pendingFeedback ?? [], {
		transition,
		receivedAt: Date.now(),
	});
	if (next) await ctx.db.patch(row._id, { pendingFeedback: next });
	return true;
}
