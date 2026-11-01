<script setup lang="ts">
// The alerts above the campaign editor's form: a screening block that sent the
// campaign back to draft, the last save's error, and the scheduled-send notice
// with Unschedule and Cancel. Several roots, so each alert stays a direct child
// of the form's spaced column.
defineProps<{
	contentBlockReason?: string;
	saveError: string | null | undefined;
	isScheduled: boolean;
	scheduledAt?: number;
	scheduledAtDisplay: string;
	isSaving: boolean;
}>();

const emit = defineEmits<{ unschedule: []; cancel: [] }>();

const { t } = useI18n();
</script>

<template>
	<!-- Content Block Reason Alert (shown when campaign was blocked and reverted to draft) -->
	<div
		v-if="contentBlockReason"
		class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
	>
		<Icon name="lucide:shield-alert" class="w-5 h-5 text-error shrink-0 mt-0.5" />
		<div>
			<p class="text-sm font-medium text-text-primary">
				{{ t('dashboard.campaigns.detail.edit.contentBlocked.title') }}
			</p>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.campaigns.detail.edit.contentBlocked.description') }}
			</p>
			<p class="text-xs text-text-tertiary mt-1">
				{{ contentBlockReason }}
			</p>
		</div>
	</div>
	<!-- Error Alert -->
	<div
		v-if="saveError"
		class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3"
	>
		<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
		<div>
			<p class="text-sm font-medium text-error">{{ t('common.error') }}</p>
			<p class="text-sm text-error/80">{{ saveError }}</p>
		</div>
	</div>

	<!-- Scheduled Campaign Notice -->
	<div v-if="isScheduled && scheduledAt" class="p-4 bg-brand/10 border border-brand/20 rounded-lg">
		<div class="flex items-start gap-3">
			<Icon name="lucide:clock" class="w-5 h-5 text-brand shrink-0 mt-0.5" />
			<div class="flex-1">
				<p class="text-sm font-medium text-brand">
					{{ t('dashboard.campaigns.detail.edit.scheduledNotice.title') }}
				</p>
				<I18nT
					keypath="dashboard.campaigns.detail.edit.scheduledNotice.description"
					tag="p"
					class="text-sm text-brand/80 mt-1"
					scope="global"
				>
					<template #date>
						<span class="font-medium">{{ scheduledAtDisplay }}</span>
					</template>
				</I18nT>
				<div class="flex gap-2 mt-3">
					<button
						class="text-sm text-brand hover:text-brand/80 font-medium"
						:disabled="isSaving"
						@click="emit('unschedule')"
					>
						{{ t('dashboard.campaigns.detail.edit.scheduledNotice.unschedule') }}
					</button>
					<span class="text-brand/40">|</span>
					<button
						class="text-sm text-error hover:text-error/80 font-medium"
						:disabled="isSaving"
						@click="emit('cancel')"
					>
						{{ t('dashboard.campaigns.detail.edit.scheduledNotice.cancelCampaign') }}
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
