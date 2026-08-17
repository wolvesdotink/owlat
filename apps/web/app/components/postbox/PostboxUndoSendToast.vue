<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { state, dismiss } = usePostboxUndoSend();
const stack = usePostboxComposerStack();
// Offline-queued sends arm this toast with a synthetic `outbox:` token
// (adoption-gaps D8); undo for those un-queues on-device instead of asking
// the server to cancel.
const offlineOutbox = usePostboxOfflineOutbox();
const cancelPending = useBackendOperation(api.mail.drafts.cancelPendingSend, {
	label: 'Undo send',
});

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
	timer = setInterval(() => {
		now.value = Date.now();
	}, 250);
});
onUnmounted(() => {
	if (timer) clearInterval(timer);
});

const remainingMs = computed(() => Math.max(0, state.value.sendAt - now.value));
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000));

// Honest copy for an offline-queued send: nothing is "sending" yet — the
// message sits in the on-device outbox until the connection returns.
const isQueued = computed(
	() => !!state.value.undoToken && isQueuedSendToken(state.value.undoToken)
);

watch(remainingMs, (ms) => {
	if (state.value.visible && ms <= 0) {
		dismiss();
	}
});

async function handleUndo() {
	const undoToken = state.value.undoToken;
	if (!undoToken) {
		dismiss();
		return;
	}
	const mailboxId = state.value.mailboxId;
	if (isQueuedSendToken(undoToken)) {
		// Offline queue: undo = un-queue. Reopen the composer seeded from the
		// queued payload so the message lands back in the editor, nothing lost.
		const item = await offlineOutbox.undoQueuedSend(undoToken);
		dismiss();
		if (item && mailboxId) {
			stack.open({
				mailboxId,
				...(item.payload.draftId ? { draftId: item.payload.draftId as Id<'mailDrafts'> } : {}),
				prefillTo: item.payload.toAddresses,
				prefillCc: item.payload.ccAddresses,
				prefillBcc: item.payload.bccAddresses,
				prefillSubject: item.payload.subject,
				prefillBodyHtml: item.payload.bodyHtml,
			});
		}
		return;
	}
	const result = await cancelPending.run({ undoToken });
	dismiss();
	// Reopen the recovered draft so the user lands back in the editor.
	if (result?.ok && result.draftId && mailboxId) {
		stack.open({ mailboxId, draftId: result.draftId as Id<'mailDrafts'> });
	}
}
</script>

<template>
	<Transition name="pbx-toast">
		<div
			v-if="state.visible && remainingSec > 0"
			class="fixed bottom-4 left-4 bg-text-primary text-text-inverse rounded-md shadow-lg px-4 py-3 flex items-center gap-3 z-50"
		>
			<Icon name="lucide:send" class="w-4 h-4" />
			<span class="text-sm">{{
				isQueued
					? `Queued — sends when you're back online (${remainingSec}s)`
					: `Sending… (${remainingSec}s)`
			}}</span>
			<button
				type="button"
				class="text-sm font-semibold text-brand hover:underline"
				@click="handleUndo"
			>
				Undo
			</button>
		</div>
	</Transition>
</template>
