<script setup lang="ts">
/**
 * One reply waiting to be confirmed sent, before its conversation's open tasks
 * are offered for finishing. Renders nothing.
 *
 * It watches the server's own record of the send, never the clock: the end of
 * an undo window only means the dispatch started, and a dispatch can still be
 * refused (a blocked recipient, no sender identity) or fail in the transport.
 *
 *   mail      the draft (`mail.drafts.get`) until the send files it, then the
 *             sent message's `outbound` state for every recipient;
 *   approve   the inbound message's `processingStatus` (`inbox.queries.getThread`),
 *             `approved` until its Send is terminal;
 *   followUp  the follow-up's `status` (`inbox.followUps.listForThread`).
 *
 * `sent` shows the offer once; anything else drops it. The hold is released
 * either way, which unmounts this watcher and its subscriptions; a reply that
 * never settles is given up on after `GIVE_UP_MS`.
 */
import { onBeforeUnmount, watch } from 'vue';
import { api } from '@owlat/api';
import {
	releaseReplyTaskHold,
	useReplyTaskOffer,
	type ReplyTaskHold,
} from '~/composables/useReplyTaskOffer';
import {
	followUpStatus,
	mailReplyStatus,
	outboundBaseline,
	teamReplyStatus,
	type ReplySendStatus,
} from '~/utils/replyTaskOffer';

/** Longer than any undo window and a transport's retries; a stuck send offers nothing. */
const GIVE_UP_MS = 30 * 60_000;

const props = defineProps<{ hold: ReplyTaskHold }>();
const hold = props.hold;

const { offer } = useReplyTaskOffer();

const draft = useConvexQuery(api.mail.drafts.get, () =>
	hold.kind === 'mail' ? { draftId: hold.draftId } : 'skip'
);
const delivery = useConvexQuery(api.mail.mailbox.messages.listThreadOutboundDelivery, () =>
	hold.kind === 'mail' ? { messageId: hold.threadMessageId } : 'skip'
);
const threadId = hold.target.conversationThreadId;
const thread = useConvexQuery(api.inbox.queries.getThread, () =>
	hold.kind === 'approve' && threadId ? { threadId } : 'skip'
);
const followUps = useConvexQuery(api.inbox.followUps.listForThread, () =>
	hold.kind === 'followUp' && threadId ? { threadId } : 'skip'
);

/** The thread's sent mail while the draft was still held: ours is the row that joins it. */
let baseline: string[] | null = null;

function status(): ReplySendStatus {
	switch (hold.kind) {
		case 'mail': {
			const held = draft.data.value as { state: string } | null | undefined;
			const rows = delivery.data.value;
			if (held?.state === 'pending_send' && rows) baseline = outboundBaseline(rows);
			return mailReplyStatus({ draft: held, baseline, delivery: rows });
		}
		case 'approve':
			return teamReplyStatus(thread.data.value?.messages, hold.inboundMessageId);
		case 'followUp':
			return followUpStatus(followUps.data.value, hold.followUpId);
	}
}

let isSettled = false;
function settle(outcome: Exclude<ReplySendStatus, 'waiting'>) {
	if (isSettled) return;
	isSettled = true;
	if (outcome === 'sent') void offer(hold.target);
	releaseReplyTaskHold(hold.key);
}

watch(
	() => [draft.data.value, delivery.data.value, thread.data.value, followUps.data.value],
	() => {
		const now = status();
		if (now !== 'waiting') settle(now);
	},
	{ immediate: true }
);

const giveUp = setTimeout(() => settle('failed'), GIVE_UP_MS);
onBeforeUnmount(() => clearTimeout(giveUp));
</script>

<template>
	<span hidden />
</template>
