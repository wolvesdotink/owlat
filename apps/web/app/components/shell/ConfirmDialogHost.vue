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
 *
 * The host itself is eager (a question asked before a lazy host arrived would
 * find none and answer no), but the dialog it renders is imported on the first
 * question: app.vue boots every page, and the dialog with its modal would
 * otherwise sit in the entry bundle for pages that never ask anything. A
 * question asked while the import is in flight waits in the queue; if the
 * import fails, that question is answered no instead of waiting forever.
 */
import { nextTick, onBeforeUnmount, ref, shallowRef, watch, type Component } from 'vue';
import {
	pendingConfirms,
	registerConfirmHost,
	respondToConfirm,
	type ConfirmRequest,
} from '~/composables/useConfirm';

const unregister = registerConfirmHost();
onBeforeUnmount(unregister);

const dialog = shallowRef<Component | null>(null);
let loading: Promise<Component> | null = null;
function loadDialog(): Promise<Component> {
	loading ??= import('@owlat/ui/components/ui/ConfirmationDialog.vue').then(
		(module) => (dialog.value = module.default),
		(error: unknown) => {
			// Forget the failure so the next question tries the import again.
			loading = null;
			throw error;
		}
	);
	return loading;
}

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
		if (!dialog.value) {
			try {
				await loadDialog();
			} catch {
				respondToConfirm(next.id, false);
				return;
			}
			if (current !== generation) return;
		}
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
	<component
		:is="dialog"
		v-if="dialog"
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
	</component>
</template>
