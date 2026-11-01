<script setup lang="ts">
// The campaign editor while the campaign is held for review: nothing is
// editable, so it explains the hold (and the screening's reason, if any).
defineProps<{ contentBlockReason?: string }>();

const emit = defineEmits<{ back: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="max-w-4xl mx-auto px-6 py-8">
		<div class="p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-3 mb-6">
			<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<div>
				<p class="text-sm font-medium text-text-primary">
					{{ t('dashboard.campaigns.detail.edit.underReview.title') }}
				</p>
				<p class="text-sm text-text-secondary mt-1">
					{{ t('dashboard.campaigns.detail.edit.underReview.description') }}
				</p>
			</div>
		</div>
		<div
			v-if="contentBlockReason"
			class="p-4 bg-error/10 border border-error/20 rounded-lg flex items-start gap-3 mb-6"
		>
			<Icon name="lucide:alert-triangle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
			<div>
				<p class="text-sm font-medium text-text-primary">
					{{ t('dashboard.campaigns.detail.edit.underReview.issuesTitle') }}
				</p>
				<p class="text-sm text-text-secondary mt-1">
					{{ contentBlockReason }}
				</p>
			</div>
		</div>
		<UiButton variant="secondary" @click="emit('back')">
			{{ t('dashboard.campaigns.detail.edit.backToCampaigns') }}
		</UiButton>
	</div>
</template>
