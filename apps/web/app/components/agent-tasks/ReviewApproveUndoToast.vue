<script setup lang="ts">
/**
 * The shared "Approved — Undo (14s)" countdown toast for review-queue
 * approvals. Mirrors PostboxUndoSendToast: a singleton state machine
 * (useReviewApproveUndo) armed by whichever surface just approved, a live
 * countdown to the held send's `sendAt`, and an Undo button that runs that
 * surface's true inverse (undoAutoSend + row restore / flow rewind).
 * Auto-dismisses when the window elapses — the send is on its way.
 */
const { state, dismiss, runUndo } = useReviewApproveUndo();

const { t } = useI18n();

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

const busy = ref(false);
async function handleUndo() {
	if (busy.value) return;
	busy.value = true;
	try {
		await runUndo();
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Transition name="pbx-toast">
		<div
			v-if="state.visible && remainingSec > 0"
			class="fixed bottom-4 left-4 bg-text-primary text-text-inverse rounded-md shadow-lg px-4 py-3 flex items-center gap-3 z-50"
		>
			<Icon name="lucide:check" class="w-4 h-4" />
			<!-- A bulk approve arms a per-id partial-result label ("8 approved,
			     2 held — Dana is replying"); a single approve keeps "Approved". -->
			<span class="text-sm">{{
				t('components.agentTasks.reviewApproveUndoToast.sendingIn', {
					what: state.label ?? t('components.agentTasks.reviewApproveUndoToast.approved'),
					seconds: remainingSec,
				})
			}}</span>
			<button
				type="button"
				class="text-sm font-semibold text-brand hover:underline"
				:disabled="busy"
				@click="handleUndo"
			>
				{{
					t('components.agentTasks.reviewApproveUndoToast.undo', { seconds: remainingSec })
				}}
			</button>
		</div>
	</Transition>
</template>
