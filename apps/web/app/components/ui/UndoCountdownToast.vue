<script setup lang="ts">
/**
 * The countdown toast behind every undo window: "Sending in 9s — Undo".
 *
 * Owns what the undo toasts share: the 250 ms clock, the seconds left until
 * `sendAt`, the `expire` event once they run out, the busy guard that keeps a
 * double click from running `onUndo` twice, and the status role that has the
 * countdown announced. The adapters (PostboxUndoSendToast, the campaign
 * UndoSendToast, ReviewApproveUndoToast) supply the copy and the reversal.
 *
 * It does not position itself: it teleports into the shared region the layout
 * renders (UNDO_TOAST_REGION_ID), which stacks live windows as a column.
 */
import { useNow } from '~/composables/useNow';
import { UNDO_TOAST_REGION_ID } from '~/utils/undoToastRegion';

const props = defineProps<{
	visible: boolean;
	/** Epoch ms the held action fires. */
	sendAt: number;
	icon: string;
	message: (seconds: number) => string;
	undoLabel: string | ((seconds: number) => string);
	onUndo: () => Promise<unknown> | unknown;
}>();

const emit = defineEmits<{
	/** The window ran out while visible: the action is on its way. */
	expire: [];
}>();

const now = useNow({ intervalMs: 250 });
const remainingMs = computed(() => Math.max(0, props.sendAt - now.value));
const remainingSec = computed(() => Math.ceil(remainingMs.value / 1000));

watch(
	() => props.visible && remainingMs.value <= 0,
	(expired) => {
		if (expired) emit('expire');
	},
	{ immediate: true }
);

const undoText = computed(() =>
	typeof props.undoLabel === 'function' ? props.undoLabel(remainingSec.value) : props.undoLabel
);

const busy = ref(false);
async function handleUndo() {
	if (busy.value) return;
	busy.value = true;
	try {
		await props.onUndo();
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Teleport :to="`#${UNDO_TOAST_REGION_ID}`" defer>
		<Transition name="pbx-toast">
			<div
				v-if="visible && remainingSec > 0"
				role="status"
				aria-live="polite"
				class="bg-text-primary text-text-inverse rounded-md shadow-lg px-4 py-3 flex items-center gap-3"
			>
				<Icon :name="icon" class="w-4 h-4" />
				<span class="text-sm">{{ message(remainingSec) }}</span>
				<button
					type="button"
					class="text-sm font-semibold text-brand hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
					:disabled="busy"
					@click="handleUndo"
				>
					{{ undoText }}
				</button>
			</div>
		</Transition>
	</Teleport>
</template>
