import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useTaskActions } from '~/composables/useTaskActions';
import { createReplySendHolds, mailReplyWillLeave, replyTaskOffer } from '~/utils/replyTaskOffer';

/** The conversation a reply went to, as `tasks.forThread` takes it. */
export interface ReplyTaskTarget {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}

/**
 * The undo windows a reply can wait out: a Postbox send (`undoToken`), a team
 * draft approve (`approveHoldToken`) and a team follow-up (its id).
 */
export type ReplySendWindow = 'mail' | 'approve' | 'followUp';

/** A Postbox reply as its composer reported it (PostboxComposer's `sent`). */
export interface MailReplySent {
	scheduled: boolean;
	receipt?: { undoToken: string; sendAt: number };
	/** The receipt is the on-device outbox's (`isQueuedSendToken`). */
	queuedOffline: boolean;
}

/** A team reply that went out (useTeamThreadComposer's `onSent`); `sendAt` ends its undo window. */
export type TeamReplySent =
	| { kind: 'reply'; messageId: string; sendAt?: number }
	| { kind: 'followUp'; followUpId: string; sendAt?: number };

/**
 * Module state, not component state: a reply is usually sent from a page that
 * leaves right after (Answer mode goes back), and the offer has to outlive it.
 * The held closure keeps the sending page's own toast and task actions, which
 * do not need the page to stay mounted.
 */
const holds = createReplySendHolds<() => void>();
const holdKey = (kind: ReplySendWindow, token: string) => `${kind}:${token}`;

/**
 * An approve's undo window is keyed by its message. The same message can be
 * approved again after an Undo, so the time it leaves tells the two apart.
 */
export function approveHoldToken(messageId: string, sendAt: number): string {
	return `${messageId}@${sendAt}`;
}

/** The sender took the reply back: Undo on its toast, or on the follow-up. */
export function cancelReplyTaskOffer(kind: ReplySendWindow, token: string): void {
	holds.cancel(holdKey(kind, token));
}

/**
 * Offers to finish the viewer's open tasks from a conversation once a reply to
 * it has actually gone (see `utils/replyTaskOffer`). Call from setup.
 *
 * `offerWhenSent` waits for the reply's undo window to close, which is when
 * the server dispatches it; an Undo in the meantime cancels the hold
 * (`cancelReplyTaskOffer`). A reply that left at once uses `offer` directly.
 */
export function useReplyTaskOffer() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const convex = useConvex();
	const { setStatus } = useTaskActions();

	async function offer(target: ReplyTaskTarget): Promise<void> {
		const args = target.mailThreadId
			? { mailThreadId: target.mailThreadId }
			: target.conversationThreadId
				? { conversationThreadId: target.conversationThreadId }
				: null;
		if (!args || !convex) return;
		let tasks;
		try {
			tasks = await convex.query(api.tasks.tasks.forThread, args);
		} catch {
			// An offer, not a duty: without the list there is nothing to offer.
			return;
		}
		const decision = replyTaskOffer(tasks);
		if (!decision) return;
		if (decision.kind === 'one') {
			const task = decision.task;
			showToast(t('components.tasks.replyOffer.one', { title: task.title }), 'success', {
				action: {
					label: t('components.tasks.replyOffer.markDone'),
					onAction: () => void setStatus(task, 'done'),
				},
			});
			return;
		}
		const firstId = decision.first._id;
		showToast(
			t('components.tasks.replyOffer.several', { count: decision.count }, decision.count),
			'success',
			{
				action: {
					label: t('components.tasks.replyOffer.review'),
					onAction: () => void navigateTo(`/dashboard/tasks?task=${firstId}`),
				},
			}
		);
	}

	/** Offer once `sendAt` (the end of the reply's undo window) has passed without an Undo. */
	function offerWhenSent(
		kind: ReplySendWindow,
		token: string,
		target: ReplyTaskTarget,
		sendAt: number
	): void {
		const key = holdKey(kind, token);
		holds.hold(key, () => void offer(target));
		setTimeout(() => holds.release(key)?.(), Math.max(0, sendAt - Date.now()));
	}

	function offerAfterMailReply(sent: MailReplySent, mailThreadId: string | null | undefined) {
		const receipt = sent.receipt;
		if (!mailThreadId || !receipt || !mailReplyWillLeave(sent)) return;
		const target = { mailThreadId: mailThreadId as Id<'mailThreads'> };
		offerWhenSent('mail', receipt.undoToken, target, receipt.sendAt);
	}

	function offerAfterTeamReply(
		sent: TeamReplySent,
		conversationThreadId: Id<'conversationThreads'>
	) {
		const target = { conversationThreadId };
		// No window: the server dispatches it now.
		if (sent.sendAt === undefined) void offer(target);
		else if (sent.kind === 'reply') {
			offerWhenSent('approve', approveHoldToken(sent.messageId, sent.sendAt), target, sent.sendAt);
		} else offerWhenSent('followUp', sent.followUpId, target, sent.sendAt);
	}

	return { offer, offerWhenSent, offerAfterMailReply, offerAfterTeamReply };
}
