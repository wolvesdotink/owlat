/**
 * Team-inbox collision safety (guard half): warn before sending a reply that a
 * teammate has already answered.
 *
 * When the composer is a reply into a shared inbox, we snapshot the thread's
 * newest outbound reply as the box opens and keep the `mailbox.latestReplyState`
 * query live (existing Convex reactivity — no presence infrastructure). If a
 * DIFFERENT teammate replies while the box is open, `isStale` flips true and the
 * composer confirms before sending a duplicate. Inert for personal mailboxes
 * (the query returns null there) and for fresh composes (no in-reply-to).
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isReplyStale, type ReplyStateSnapshot } from '~/utils/postboxStaleReply';

interface StaleReplyGuardOptions {
	/** Re-run the send once the user confirms past the collision warning. */
	onConfirm: (opts?: { scheduledSendAt?: number; allowUnsealed?: boolean }) => void;
}

export function usePostboxStaleReplyGuard(
	inReplyToMessageId: MaybeRefOrGetter<Id<'mailMessages'> | undefined>,
	options: StaleReplyGuardOptions
) {
	const messageId = computed(() => toValue(inReplyToMessageId));

	const { data } = useConvexQuery(api.mail.mailbox.latestReplyState, () =>
		messageId.value ? { messageId: messageId.value } : 'skip'
	);

	const liveSnapshot = computed<ReplyStateSnapshot | null>(() => {
		const reply = data.value;
		if (!reply) return null;
		return { messageId: reply.messageId, byIsYou: reply.byIsYou };
	});

	// The thread's last reply when the composer opened — captured once the query
	// first settles, then frozen. Reactive changes afterwards are the collision
	// we are guarding against.
	const openedSnapshot = ref<ReplyStateSnapshot | null>(null);
	let captured = false;
	watch(
		data,
		(reply) => {
			if (captured || reply === undefined) return;
			captured = true;
			openedSnapshot.value = reply
				? { messageId: reply.messageId, byIsYou: reply.byIsYou }
				: { messageId: null, byIsYou: false };
		},
		{ immediate: true }
	);

	const isStale = computed(() => isReplyStale(openedSnapshot.value, liveSnapshot.value));

	// Who to name in the warning; null when no other teammate reply is known.
	const staleReplyByName = computed(() => data.value?.byName ?? null);

	// Confirm-dialog orchestration lives here so the composer only wires the
	// dialog and calls `blockSend`. Asked once per composer: after the user
	// confirms, `acknowledged` short-circuits the guard so they aren't re-blocked.
	const confirmOpen = ref(false);
	let acknowledged = false;
	let pendingOpts: { scheduledSendAt?: number; allowUnsealed?: boolean } | undefined;

	/**
	 * Returns true when the send must pause for confirmation (a teammate replied
	 * since this reply opened and the user hasn't acknowledged it yet) — the
	 * caller returns early. Returns false when the send may proceed.
	 */
	function blockSend(opts?: { scheduledSendAt?: number; allowUnsealed?: boolean }): boolean {
		if (!isStale.value || acknowledged) return false;
		pendingOpts = opts;
		confirmOpen.value = true;
		return true;
	}

	function confirm() {
		confirmOpen.value = false;
		acknowledged = true;
		options.onConfirm(pendingOpts);
	}

	return { staleReplyByName, confirmOpen, blockSend, confirm };
}
