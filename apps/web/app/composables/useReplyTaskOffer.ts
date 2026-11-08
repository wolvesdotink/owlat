import { shallowRef, type ShallowRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useTaskActions } from '~/composables/useTaskActions';
import { mailReplyWillLeave, replyTaskOffer } from '~/utils/replyTaskOffer';

/** The conversation a reply went to, as `tasks.forThread` takes it. */
export interface ReplyTaskTarget {
	mailThreadId?: Id<'mailThreads'>;
	conversationThreadId?: Id<'conversationThreads'>;
}

/**
 * A reply waiting to be confirmed sent, with the server record that will say
 * so (see `ReplyTaskOfferWatch`, which watches it).
 */
export type ReplyTaskHold =
	/** A Postbox reply: its draft, and a message of its thread to read the thread's sent mail by. */
	| {
			kind: 'mail';
			key: string;
			target: ReplyTaskTarget;
			draftId: Id<'mailDrafts'>;
			threadMessageId: Id<'mailMessages'>;
	  }
	/** A team draft approved: the inbound message it answers. */
	| {
			kind: 'approve';
			key: string;
			target: ReplyTaskTarget;
			inboundMessageId: Id<'inboundMessages'>;
	  }
	/** A team follow-up. */
	| { kind: 'followUp'; key: string; target: ReplyTaskTarget; followUpId: Id<'inboxFollowUps'> };

/** A Postbox reply as its composer reported it (PostboxComposer's `sent`). */
export interface MailReplySent {
	scheduled: boolean;
	/** The receipt is the on-device outbox's (`isQueuedSendToken`). */
	queuedOffline: boolean;
}

/** A team reply that went out (useTeamThreadComposer's `onSent`). */
export type TeamReplySent =
	| { kind: 'reply'; messageId: string; sendAt?: number }
	| { kind: 'followUp'; followUpId: string; sendAt?: number };

/**
 * Module state, not component state: a reply is usually sent from a page that
 * leaves right after (Answer mode goes back). The shell's composer host
 * (ShellComposerOverlay) mounts one watcher per hold, so a hold lives as long
 * as the dashboard does and no longer.
 */
const holds: ShallowRef<readonly ReplyTaskHold[]> = shallowRef([]);

/** The replies waiting to be confirmed sent. Read-only: add through the helpers below. */
export function useReplyTaskHolds(): Readonly<ShallowRef<readonly ReplyTaskHold[]>> {
	return holds;
}

function hold(entry: ReplyTaskHold): void {
	if (holds.value.some((h) => h.key === entry.key)) return;
	holds.value = [...holds.value, entry];
}

/** The hold has settled (sent and offered, failed, undone, or given up on). */
export function releaseReplyTaskHold(key: string): void {
	holds.value = holds.value.filter((h) => h.key !== key);
}

/** The shell is gone (signed out, left the dashboard): nothing is watched or offered any more. */
export function clearReplyTaskHolds(): void {
	holds.value = [];
}

/** Watch a Postbox reply until the server confirms it sent. */
export function holdMailReplyOffer(
	sent: MailReplySent,
	ids: {
		draftId: string | null | undefined;
		threadMessageId: string;
		mailThreadId: string | null | undefined;
	}
): void {
	if (!ids.draftId || !ids.mailThreadId || !mailReplyWillLeave(sent)) return;
	hold({
		kind: 'mail',
		key: `mail:${ids.draftId}`,
		target: { mailThreadId: ids.mailThreadId as Id<'mailThreads'> },
		draftId: ids.draftId as Id<'mailDrafts'>,
		threadMessageId: ids.threadMessageId as Id<'mailMessages'>,
	});
}

/** Watch a team reply until the server confirms its Send went out. */
export function holdTeamReplyOffer(
	sent: TeamReplySent,
	conversationThreadId: Id<'conversationThreads'>
): void {
	const target = { conversationThreadId };
	if (sent.kind === 'reply') {
		hold({
			kind: 'approve',
			// Approved again after an Undo is another send: the window end tells them apart.
			key: `approve:${sent.messageId}:${sent.sendAt ?? 'now'}`,
			target,
			inboundMessageId: sent.messageId as Id<'inboundMessages'>,
		});
	} else {
		hold({
			kind: 'followUp',
			key: `followUp:${sent.followUpId}`,
			target,
			followUpId: sent.followUpId as Id<'inboxFollowUps'>,
		});
	}
}

/**
 * The toast offering to finish the viewer's open tasks from a conversation
 * (see `utils/replyTaskOffer`), for a reply already confirmed sent. Call from
 * setup.
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

	return { offer };
}
