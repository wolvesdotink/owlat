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
const { t } = useI18n();

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
				<h3 class="text-base font-semibold text-text-primary">
					{{ t('components.autonomy.autonomyKillSwitch.title') }}
				</h3>
				<p class="text-sm text-text-secondary mt-1">
					<I18nT keypath="components.autonomy.autonomyKillSwitch.body" tag="span" scope="global">
						<template #mode>
							<strong>{{ t('components.autonomy.autonomyKillSwitch.bodyMode') }}</strong>
						</template>
					</I18nT>
				</p>

				<UiButton
					variant="danger"
					v-if="!showConfirm"
					data-testid="kill-switch-open"
					class="gap-2 mt-4"
					:disabled="busy"
					@click="showConfirm = true"
				>
					<Icon name="lucide:octagon-x" class="w-4 h-4" />
					{{ t('components.autonomy.autonomyKillSwitch.stopCta') }}
				</UiButton>

				<div v-else class="mt-4 flex flex-wrap items-center gap-3">
					<span class="text-sm text-text-primary font-medium">
						{{ t('components.autonomy.autonomyKillSwitch.confirmQuestion') }}
					</span>
					<UiButton
						variant="danger"
						data-testid="kill-switch-confirm"
						class="gap-2"
						:disabled="busy"
						@click="handleConfirm"
					>
						<UiSpinner v-if="busy" size="xs" tone="inverse" />
						<Icon v-else name="lucide:check" class="w-4 h-4" />
						{{ t('components.autonomy.autonomyKillSwitch.confirmCta') }}
					</UiButton>
					<UiButton variant="secondary" :disabled="busy" @click="showConfirm = false">
						{{ t('common.cancel') }}
					</UiButton>
				</div>
			</div>
		</div>
	</UiCard>
</template>
