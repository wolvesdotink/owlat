<script setup lang="ts">
// The builder's "Activate automation?" confirmation: what goes live (name,
// trigger, step count), and why it did not activate when the open step's
// edits could not be saved first.
import { getTriggerInfo } from '~/composables/automations/editorDisplay';
import { CircleWarningIcon, PlayIcon } from '@coolicons/vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

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
	<UiModal
		:open="open"
		:title="t('dashboard.automations.detail.edit.activateDialog.title')"
		size="sm"
		@update:open="(value: boolean) => !value && emit('close')"
	>
		<p class="text-text-secondary mb-6">
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
		<dl v-if="automation" class="bg-bg-surface shadow-surface-1 rounded-lg p-4 space-y-3">
			<div class="flex items-center justify-between gap-4">
				<dt class="text-sm text-text-tertiary">
					{{ t('dashboard.automations.detail.edit.activateDialog.automation') }}
				</dt>
				<dd class="min-w-0 truncate text-sm font-medium text-text-primary" :title="automation.name">
					{{ automation.name }}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-4">
				<dt class="text-sm text-text-tertiary">
					{{ t('dashboard.automations.detail.edit.trigger') }}
				</dt>
				<dd class="text-sm font-medium text-text-primary">
					{{ t(getTriggerInfo(automation.triggerType).label) }}
				</dd>
			</div>
			<div class="flex items-center justify-between gap-4">
				<dt class="text-sm text-text-tertiary">
					{{ t('dashboard.automations.detail.edit.activateDialog.steps') }}
				</dt>
				<dd class="text-sm font-medium text-text-primary">
					{{
						t(
							'dashboard.automations.detail.edit.activateDialog.stepCount',
							{ count: stepCount },
							stepCount
						)
					}}
				</dd>
			</div>
		</dl>

		<template #footer>
			<UiButton variant="secondary" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="isActivating" @click="emit('confirm')">
				<template v-if="!isActivating" #iconLeft>
					<PlayIcon class="w-4 h-4" />
				</template>
				{{
					isActivating
						? t('dashboard.automations.detail.edit.activating')
						: t('dashboard.automations.detail.edit.activate')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
