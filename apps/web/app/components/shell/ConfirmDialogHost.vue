<script setup lang="ts">
/**
 * The one dialog behind `useConfirm()`, mounted once in app.vue.
 *
 * It shows the oldest open question and answers it through the store; every
 * way out other than the confirm button (Cancel, Escape, backdrop, Close)
 * reaches `update:open` and answers "no". The presentation is
 * `UiConfirmationDialog`'s, so a prompt asked this way looks, focuses (Cancel
 * first) and announces exactly like a declarative one.
 *
 * Between two queued questions the dialog closes and reopens instead of
 * swapping its copy in place: reopening restores focus to the opener and
 * puts it back on Cancel, so the Enter that confirmed the first question can
 * never confirm the second.
 */
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import {
	pendingConfirms,
	registerConfirmHost,
	respondToConfirm,
	type ConfirmRequest,
} from '~/composables/useConfirm';

const unregister = registerConfirmHost();
onBeforeUnmount(unregister);

const open = ref(false);
// Kept after the answer so the leave transition still shows the copy it closes on.
const shown = shallowRef<ConfirmRequest | null>(null);

let generation = 0;
watch(
	() => pendingConfirms.value[0] ?? null,
	async (next) => {
		const current = ++generation;
		if (open.value) {
			open.value = false;
			await nextTick();
			if (current !== generation) return;
		}
		if (!next) return;
		shown.value = next;
		open.value = true;
	},
	{ immediate: true }
);

function answer(confirmed: boolean) {
	if (open.value && shown.value) respondToConfirm(shown.value.id, confirmed);
}
</script>

<template>
	<UiConfirmationDialog
		:open="open"
		:title="shown?.title"
		:confirm-text="shown?.confirmText"
		:cancel-text="shown?.cancelText"
		:variant="shown?.variant ?? 'default'"
		@confirm="answer(true)"
		@update:open="(value: boolean) => value || answer(false)"
	>
		<!-- Always rendered, empty without a body: an empty slot would fall back
		     to the dialog's "This action cannot be undone.", which is not true of
		     every question asked here. -->
		<template #description>
			<p class="text-text-secondary whitespace-pre-line">{{ shown?.body }}</p>
		</template>
	</UiConfirmationDialog>
</template>
