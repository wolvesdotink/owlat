<script setup lang="ts">
/**
 * ONE-CLICK KILL SWITCH — the single obvious "stop auto-sending NOW" lever.
 *
 * Presentational: renders a prominent stop control and a confirm step, and emits
 * `confirm` once the operator confirms. The parent page wires the actual
 * `agentConfigMutations.killSwitch` mutation (which disables the ai.autonomy
 * flag, forces the legacy auto-reply toggle off, and cancels in-flight delayed
 * auto-sends). Kept prop-driven so it is trivially unit-testable without a
 * Convex/Nuxt context.
 */
interface Props {
	// True while the kill-switch mutation is in flight.
	busy?: boolean;
}
const props = withDefaults(defineProps<Props>(), { busy: false });

const emit = defineEmits<{ confirm: [] }>();

const showConfirm = ref(false);

const handleConfirm = () => {
	emit('confirm');
	showConfirm.value = false;
};
</script>

<template>
	<UiCard class="border-error/40">
		<div class="flex items-start gap-4">
			<UiIconBox icon="lucide:octagon-x" size="lg" variant="error" rounded="full" />
			<div class="flex-1">
				<h3 class="text-base font-semibold text-text-primary">Stop auto-sending now</h3>
				<p class="text-sm text-text-secondary mt-1">
					Instantly revert to <strong>draft-only</strong>: turns off graduated autonomy and the
					legacy auto-reply, and pulls back any auto-send still in its undo window. The agent keeps
					drafting replies for you to review — nothing is dropped.
				</p>

				<button
					v-if="!showConfirm"
					data-testid="kill-switch-open"
					class="btn bg-error text-white hover:bg-error/90 gap-2 mt-4"
					:disabled="busy"
					@click="showConfirm = true"
				>
					<Icon name="lucide:octagon-x" class="w-4 h-4" />
					Stop auto-sending
				</button>

				<div v-else class="mt-4 flex flex-wrap items-center gap-3">
					<span class="text-sm text-text-primary font-medium">Revert to draft-only?</span>
					<button
						data-testid="kill-switch-confirm"
						class="btn bg-error text-white hover:bg-error/90 gap-2"
						:disabled="busy"
						@click="handleConfirm"
					>
						<UiSpinner v-if="busy" size="xs" tone="inverse" />
						<Icon v-else name="lucide:check" class="w-4 h-4" />
						Yes, stop now
					</button>
					<button class="btn btn-secondary" :disabled="busy" @click="showConfirm = false">
						Cancel
					</button>
				</div>
			</div>
		</div>
	</UiCard>
</template>
