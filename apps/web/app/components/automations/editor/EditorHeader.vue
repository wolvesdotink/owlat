<script setup lang="ts">
// The automation builder's title bar: Back, the name, the step save line, the
// status badge, and Save draft / Pause / Resume / Activate for the status the
// automation is in.
import type { StepSaveStatus } from '~/composables/useAutomationStepConfig';
import { ArrowLeftIcon, PauseIcon, PlayIcon, SaveIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	automation: { name: string; status: string } | null | undefined;
	isLoading: boolean;
	stepSaveStatus: StepSaveStatus;
	isSavingDraft: boolean;
	isActivating: boolean;
	canActivate: { valid: boolean; reasons: string[] };
}>();

const emit = defineEmits<{
	back: [];
	retryStepSave: [];
	saveDraft: [];
	toggleStatus: [];
	activate: [];
}>();

const { t } = useI18n();

// A draft that cannot be activated yet keeps Activate held (aria-disabled, not
// disabled) so keyboard and pointer users can still reach it and its tooltip
// can list what is missing: `.btn:disabled` drops pointer events and a disabled
// button leaves the tab order. The fill fades through colour alpha so the
// focus ring stays at full strength; the click handler keeps it inert.
const ACTIVATE_HELD_CLASS =
	'cursor-not-allowed active:scale-100 bg-text-primary/50 hover:bg-text-primary/50';
</script>

<template>
	<div class="bg-bg-elevated border-b border-border-subtle shrink-0">
		<div class="max-w-7xl mx-auto px-4 py-4 sm:px-6">
			<!-- Wraps on a phone, so the actions drop below the name instead of
			     running off the edge. -->
			<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<div class="flex items-center gap-4 min-w-0">
					<button
						class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
						@click="emit('back')"
						:aria-label="t('common.back')"
					>
						<ArrowLeftIcon class="w-5 h-5" />
					</button>
					<div v-if="automation" class="min-w-0">
						<h1 class="text-lg font-semibold text-text-primary">{{ automation.name }}</h1>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.automations.detail.edit.editWorkflow') }}
						</p>
					</div>
					<div v-else-if="isLoading" class="animate-pulse motion-reduce:animate-none">
						<div class="h-5 w-40 bg-bg-surface rounded" />
						<div class="h-4 w-24 bg-bg-surface rounded mt-1" />
					</div>
				</div>

				<!-- Status and Actions -->
				<div v-if="automation" class="flex flex-wrap items-center gap-3">
					<!-- Mirrors the inspector's save line, which may be scrolled away. -->
					<AutomationsStepSaveStatus
						class="hidden md:flex"
						:status="stepSaveStatus"
						@retry="emit('retryStepSave')"
					/>

					<!-- Status Badge -->
					<span
						:class="[
							'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
							automation.status === 'active'
								? 'bg-success/10 text-success'
								: automation.status === 'paused'
									? 'bg-warning/10 text-warning'
									: 'bg-bg-surface text-text-secondary',
						]"
					>
						<span
							class="w-1.5 h-1.5 rounded-full"
							:class="[
								automation.status === 'active'
									? 'bg-success'
									: automation.status === 'paused'
										? 'bg-warning'
										: 'bg-text-tertiary',
							]"
						/>
						{{
							automation.status === 'active'
								? t('common.active')
								: automation.status === 'paused'
									? t('dashboard.automations.detail.edit.status.paused')
									: t('dashboard.automations.detail.edit.status.draft')
						}}
					</span>

					<!-- Save Draft Button (only for draft status) -->
					<UiButton
						variant="secondary"
						v-if="automation.status === 'draft'"
						class="gap-2"
						:disabled="isSavingDraft"
						@click="emit('saveDraft')"
					>
						<SpinnerIcon v-if="isSavingDraft" class="w-4 h-4" />
						<SaveIcon v-else class="w-4 h-4" />
						{{ t('dashboard.automations.detail.edit.saveDraft') }}
					</UiButton>

					<!-- Activate/Pause Button -->
					<UiButton
						variant="secondary"
						v-if="automation.status === 'active'"
						class="gap-2"
						:disabled="isActivating"
						@click="emit('toggleStatus')"
					>
						<SpinnerIcon v-if="isActivating" class="w-4 h-4" />
						<PauseIcon v-else class="w-4 h-4" />
						{{ t('dashboard.automations.detail.edit.pause') }}
					</UiButton>
					<UiButton
						v-else-if="automation.status === 'paused'"
						class="gap-2"
						:disabled="isActivating"
						@click="emit('toggleStatus')"
					>
						<SpinnerIcon v-if="isActivating" class="w-4 h-4" />
						<PlayIcon v-else class="w-4 h-4" />
						{{ t('dashboard.automations.detail.edit.resume') }}
					</UiButton>
					<UiTooltip
						v-else
						:text="
							!canActivate.valid
								? canActivate.reasons.join(', ')
								: t('dashboard.automations.detail.edit.activateTitle')
						"
					>
						<UiButton
							class="gap-2"
							:disabled="isActivating"
							:aria-disabled="canActivate.valid ? undefined : 'true'"
							:class="canActivate.valid ? undefined : ACTIVATE_HELD_CLASS"
							data-testid="automation-activate"
							@click="emit('activate')"
						>
							<SpinnerIcon v-if="isActivating" class="w-4 h-4" />
							<PlayIcon v-else class="w-4 h-4" />
							{{ t('dashboard.automations.detail.edit.activate') }}
						</UiButton>
					</UiTooltip>
				</div>
			</div>
		</div>
	</div>
</template>
