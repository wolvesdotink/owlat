<script setup lang="ts">
// The campaign editor's title bar: Back, the title, the campaign's name and its
// draft / scheduled / under-review badge.
import { ArrowLeftIcon, ClockIcon, PencilIcon, ShieldWarningIcon } from '@coolicons/vue';

defineProps<{
	campaign: { name?: string; status: string } | null | undefined;
	isScheduled: boolean;
	isDraft: boolean;
}>();

const emit = defineEmits<{ back: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="bg-bg-elevated border-b border-border-subtle">
		<div class="max-w-4xl mx-auto px-6 py-4">
			<div class="flex items-start gap-4">
				<button
					class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					@click="emit('back')"
					:aria-label="t('common.back')"
				>
					<ArrowLeftIcon class="w-5 h-5" />
				</button>
				<UiPageHeader
					class="flex-1"
					:title="
						isScheduled
							? t('dashboard.campaigns.detail.edit.titleScheduled')
							: t('dashboard.campaigns.detail.edit.title')
					"
					:description="campaign?.name || t('dashboard.campaigns.detail.edit.loadingName')"
				>
					<template
						v-if="campaign && (isScheduled || isDraft || campaign.status === 'pending_review')"
						#meta
					>
						<span
							v-if="isScheduled"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-brand/10 text-brand"
						>
							<ClockIcon class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.scheduled') }}
						</span>
						<span
							v-else-if="isDraft"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-text-tertiary/10 text-text-tertiary"
						>
							<PencilIcon class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.draft') }}
						</span>
						<span
							v-else-if="campaign.status === 'pending_review'"
							class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-warning/10 text-warning"
						>
							<ShieldWarningIcon class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.badges.underReview') }}
						</span>
					</template>
				</UiPageHeader>
			</div>
		</div>
	</div>
</template>
