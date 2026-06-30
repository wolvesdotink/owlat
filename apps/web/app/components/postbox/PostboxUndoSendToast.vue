<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { state, dismiss } = usePostboxUndoSend();
const stack = usePostboxComposerStack();
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

watch(remainingMs, (ms) => {
	if (state.value.visible && ms <= 0) {
		dismiss();
	}
});

async function handleUndo() {
	if (!state.value.undoToken) {
		dismiss();
		return;
	}
	const mailboxId = state.value.mailboxId;
	const result = await cancelPending.run({ undoToken: state.value.undoToken });
	dismiss();
	// Reopen the recovered draft so the user lands back in the editor.
	if (result?.ok && result.draftId && mailboxId) {
		stack.open({ mailboxId, draftId: result.draftId as Id<'mailDrafts'> });
	}
}
</script>

<template>
	<div
		v-if="state.visible && remainingSec > 0"
		class="fixed bottom-4 left-4 bg-text-primary text-white rounded-md shadow-lg px-4 py-3 flex items-center gap-3 z-50"
	>
		<Icon name="lucide:send" class="w-4 h-4" />
		<span class="text-sm">Sending… ({{ remainingSec }}s)</span>
		<button
			type="button"
			class="text-sm font-semibold text-brand hover:underline"
			@click="handleUndo"
		>
			Undo
		</button>
	</div>
</template>
