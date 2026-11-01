<script setup lang="ts">
// The Review step's A/B test summary: what is tested, both variants, the
// split and how the winner is picked.
import type { ReviewCampaignData } from '~/lib/campaignCompose';

const props = defineProps<{ data: ReviewCampaignData }>();

const emit = defineEmits<{ editStep: [step: string]; retryTemplates: [] }>();

const { t } = useI18n();

/** How the winner is picked, and — for an automatic pick — by when. */
const winnerByLine = computed(() => {
	const prefix = 'components.campaigns.steps.reviewStep';
	const criteria =
		props.data.abWinnerCriteria === 'open_rate'
			? t(`${prefix}.winnerCriteria.openRate`)
			: props.data.abWinnerCriteria === 'click_rate'
				? t(`${prefix}.winnerCriteria.clickRate`)
				: t(`${prefix}.winnerCriteria.manual`);
	return props.data.abWinnerCriteria === 'manual'
		? t(`${prefix}.winnerBy`, { criteria })
		: t(`${prefix}.winnerByAfterHours`, { criteria, hours: props.data.abTestDuration });
});

// Get variant B template name
const variantBTemplateName = computed(() => {
	if (!props.data.abVariantBTemplateId) return null;
	return (
		props.data.templates.find((template) => template._id === props.data.abVariantBTemplateId)
			?.name ?? null
	);
});
</script>

<template>
	<div
		class="flex items-start justify-between p-4 bg-bg-surface border border-border-default rounded-lg"
	>
		<div class="flex items-start gap-3">
			<UiIconBox icon="lucide:split" size="sm" rounded="lg" />
			<div class="flex-1 min-w-0">
				<p class="text-sm text-text-secondary">
					{{ t('components.campaigns.steps.reviewStep.abTesting') }}
				</p>
				<p class="font-medium text-text-primary mt-0.5">
					{{
						data.abTestType === 'subject'
							? t('components.campaigns.steps.reviewStep.testingSubjects')
							: t('components.campaigns.steps.reviewStep.testingTemplates')
					}}
				</p>
				<div class="mt-2 space-y-1">
					<div class="flex items-center gap-2 text-sm">
						<div
							class="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							A
						</div>
						<span class="text-text-secondary">{{
							data.abTestType === 'subject' ? data.campaignSubject : data.selectedTemplate?.name
						}}</span>
					</div>
					<div class="flex items-center gap-2 text-sm">
						<div
							class="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-xs font-bold"
						>
							B
						</div>
						<span class="text-text-secondary">{{
							data.abTestType === 'subject' ? data.abVariantBSubject : variantBTemplateName
						}}</span>
					</div>
					<CampaignsChangedSinceLastSend
						v-if="data.abTestType === 'content' && data.abVariantBTemplateId"
						:template-id="data.abVariantBTemplateId"
						class="pl-7"
					/>
					<p class="text-sm text-text-tertiary mt-2">
						{{
							t('components.campaigns.steps.reviewStep.splitSummary', {
								split: data.abSplitPercentage,
								remaining: Math.max(0, 100 - 2 * data.abSplitPercentage),
							})
						}}
					</p>
					<p class="text-sm text-text-tertiary">{{ winnerByLine }}</p>
					<UiErrorAlert
						v-if="data.abTestType === 'content' && data.templatesLoadFailed"
						class="mt-3"
						:message="t('components.campaigns.steps.reviewStep.templatesLoadFailed')"
						:action-label="t('common.tryAgain')"
						action-icon="lucide:refresh-cw"
						data-testid="review-templates-load-failed"
						@action="emit('retryTemplates')"
					/>
				</div>
			</div>
		</div>
		<button
			class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			@click="emit('editStep', 'setup')"
			:aria-label="t('common.edit')"
		>
			<Icon name="lucide:pencil" class="w-4 h-4" />
		</button>
	</div>
</template>
