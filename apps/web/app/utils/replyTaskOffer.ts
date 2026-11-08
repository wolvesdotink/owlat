/**
 * After a reply on a conversation has gone out, the viewer's open tasks taken
 * from that conversation may be finished too. Never automatically: a reply is
 * not proof that the task is done. These are the pure halves of that offer:
 * which toast to show, and the holds that keep it back until the send is
 * final.
 */

interface OfferableTask<Id extends string = string> {
	_id: Id;
	title: string;
	status: string;
}

export type ReplyTaskOffer<T extends OfferableTask> =
	/** "Sent. Mark “<title>” done?" with Mark done. */
	| { kind: 'one'; task: T }
	/** "Sent. 3 tasks from this conversation are still open." with Review, opening the first. */
	| { kind: 'several'; count: number; first: T };

/**
 * The offer for the conversation's tasks, or null when none is open. `tasks`
 * is `tasks.forThread`: the tasks the viewer can see, open ones first, so the
 * first open one is the one the Tasks page should open on.
 */
export function replyTaskOffer<T extends OfferableTask>(
	tasks: readonly T[] | null | undefined
): ReplyTaskOffer<T> | null {
	const open = (tasks ?? []).filter((task) => task.status === 'open');
	const first = open[0];
	if (!first) return null;
	return open.length === 1
		? { kind: 'one', task: first }
		: { kind: 'several', count: open.length, first };
}

/**
 * Where a mail reply stands once the composer reports it sent. Only a reply
 * held in its undo window (or dispatched at once, with undo-send off) will
 * leave on its own within seconds. A send scheduled for later, or one queued
 * on the device while offline, has not gone and may still be taken back long
 * after this page is gone, so neither is offered.
 */
export function mailReplyWillLeave(outcome: {
	scheduled: boolean;
	/** The receipt belongs to the on-device outbox (`isQueuedSendToken`). */
	queuedOffline: boolean;
}): boolean {
	return !outcome.scheduled && !outcome.queuedOffline;
}

/**
 * The replies waiting out their undo window, each with what to do once it has
 * gone. A hold ends one of two ways: `release` when the window has run out
 * (the message left), or `cancel` when the sender took it back. Whichever
 * comes first wins; the other then finds nothing.
 */
export function createReplySendHolds<Run>() {
	const pending = new Map<string, Run>();
	return {
		hold(key: string, run: Run): void {
			pending.set(key, run);
		},
		/** The hold's `run`, once: the reply went out. */
		release(key: string): Run | null {
			const run = pending.get(key);
			if (run === undefined) return null;
			pending.delete(key);
			return run;
		},
		/** The sender took the reply back: nothing will be offered for it. */
		cancel(key: string): void {
			pending.delete(key);
		},
		has(key: string): boolean {
			return pending.has(key);
		},
	};
}
