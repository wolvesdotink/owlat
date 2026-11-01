<script setup lang="ts">
// The builder's "Activate automation?" confirmation: what goes live (name,
// trigger, step count), and why it did not activate when the open step's
// edits could not be saved first.
import { getTriggerInfo } from '~/composables/automations/editorDisplay';
import { CircleWarningIcon, PlayIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	open: boolean;
	automation: { name: string; triggerType: string } | null | undefined;
	stepCount: number;
	isActivating: boolean;
	saveFailed: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const { t } = useI18n();
</script>

<template>
	<Teleport to="body">
		<Transition
			enter-active-class="transition-opacity duration-(--motion-fast)"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-(--motion-fast-exit)"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4">
				<!-- Backdrop -->
				<div class="absolute inset-0 bg-scrim/50 backdrop-blur-sm" @click="emit('close')" />

				<!-- Modal -->
				<div
					class="relative bg-bg-elevated border border-border-subtle rounded-xl shadow-2xl w-full max-w-md"
				>
					<div class="p-6">
						<!-- Icon -->
						<div
							class="w-12 h-12 mx-auto mb-4 rounded-full bg-brand/10 flex items-center justify-center"
						>
							<PlayIcon class="w-6 h-6 text-brand" />
						</div>

						<!-- Title -->
						<h3 class="text-lg font-semibold text-text-primary text-center mb-2">
							{{ t('dashboard.automations.detail.edit.activateDialog.title') }}
						</h3>

						<!-- Description -->
						<p class="text-text-secondary text-center mb-6">
							{{ t('dashboard.automations.detail.edit.activateDialog.body') }}
						</p>

						<div
							v-if="saveFailed"
							role="alert"
							class="flex items-start gap-2 p-3 mb-6 rounded-lg bg-error/10 border border-error/20 text-sm text-error"
						>
							<CircleWarningIcon class="w-4 h-4 shrink-0 mt-0.5" />
							<span>{{ t('dashboard.automations.detail.edit.activateDialog.saveFailed') }}</span>
						</div>

						<!-- Summary -->
						<div
							v-if="automation"
							class="bg-bg-surface border border-border-subtle rounded-lg p-4 mb-6"
						>
							<div class="space-y-3">
								<div class="flex items-center justify-between">
									<span class="text-sm text-text-tertiary">{{
										t('dashboard.automations.detail.edit.activateDialog.automation')
									}}</span>
									<span class="text-sm font-medium text-text-primary">{{ automation.name }}</span>
								</div>
								<div class="flex items-center justify-between">
									<span class="text-sm text-text-tertiary">{{
										t('dashboard.automations.detail.edit.trigger')
									}}</span>
									<span class="text-sm font-medium text-text-primary">{{
										t(getTriggerInfo(automation.triggerType).label)
									}}</span>
								</div>
								<div class="flex items-center justify-between">
									<span class="text-sm text-text-tertiary">{{
										t('dashboard.automations.detail.edit.activateDialog.steps')
									}}</span>
									<span class="text-sm font-medium text-text-primary">{{
										t(
											'dashboard.automations.detail.edit.activateDialog.stepCount',
											{ count: stepCount },
											stepCount
										)
									}}</span>
								</div>
							</div>
						</div>

						<!-- Buttons -->
						<div class="flex gap-3">
							<UiButton variant="secondary" class="flex-1" @click="emit('close')">
								{{ t('common.cancel') }}
							</UiButton>
							<UiButton class="flex-1 gap-2" :disabled="isActivating" @click="emit('confirm')">
								<SpinnerIcon v-if="isActivating" class="w-4 h-4" />
								<PlayIcon v-else class="w-4 h-4" />
								{{
									isActivating
										? t('dashboard.automations.detail.edit.activating')
										: t('dashboard.automations.detail.edit.activate')
								}}
							</UiButton>
						</div>
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
