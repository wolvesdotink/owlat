<script setup lang="ts">
// The Review step's summary rows: name, sender, audience, the email (with its
// preview and Edit email) and, for an A/B campaign, the test. Each row's pencil
// goes back to the step that sets it.
import type { ReviewCampaignData } from '~/lib/campaignCompose';
import ReviewAbTestSummary from '~/components/campaigns/steps/review/ReviewAbTestSummary.vue';

defineProps<{
	data: ReviewCampaignData;
	/** The audience size as shown ("N+" for a lower bound). */
	audienceCountLabel: string;
}>();

const emit = defineEmits<{ editStep: [step: string]; editEmail: []; retryTemplates: [] }>();

const { t } = useI18n();
</script>

<template>
	<div class="space-y-4">
		<!-- Campaign Name -->
		<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:file-text" size="sm" rounded="lg" />
				<div>
					<p class="text-sm text-text-secondary">
						{{ t('components.campaigns.steps.reviewStep.campaignName') }}
					</p>
					<p class="font-medium text-text-primary mt-0.5">{{ data.campaignName }}</p>
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

		<!-- From Info -->
		<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:user" size="sm" rounded="lg" />
				<div>
					<p class="text-sm text-text-secondary">
						{{ t('components.campaigns.steps.reviewStep.from') }}
					</p>
					<p class="font-medium text-text-primary mt-0.5">{{ data.fromName }}</p>
					<p class="text-sm text-text-secondary">{{ data.fromEmail }}</p>
					<p v-if="data.replyTo" class="text-sm text-text-tertiary">
						{{ t('components.campaigns.steps.reviewStep.replyTo', { email: data.replyTo }) }}
					</p>
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

		<!-- Audience -->
		<div class="flex items-start justify-between p-4 bg-bg-surface shadow-surface-1 rounded-lg">
			<div class="flex items-start gap-3">
				<UiIconBox icon="lucide:users" size="sm" variant="success" rounded="lg" />
				<div>
					<p class="text-sm text-text-secondary">
						{{ t('components.campaigns.steps.reviewStep.audience') }}
					</p>
					<p class="font-medium text-text-primary mt-0.5">{{ data.audienceDisplayText }}</p>
					<I18nT
						keypath="components.campaigns.steps.reviewStep.estimatedRecipients"
						tag="p"
						class="text-sm text-text-secondary mt-1"
						scope="global"
					>
						<template #count>
							<span class="font-medium text-brand">{{ audienceCountLabel }}</span>
						</template>
					</I18nT>
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

		<!-- Email Content -->
		<div class="p-4 bg-bg-surface shadow-surface-1 rounded-lg">
			<div class="flex items-start justify-between gap-3">
				<div class="flex flex-1 min-w-0 items-start gap-3">
					<UiIconBox icon="lucide:mail" size="sm" variant="warning" rounded="lg" />
					<div class="flex-1 min-w-0">
						<p class="text-sm text-text-secondary">
							{{ t('components.campaigns.steps.reviewStep.emailContent') }}
						</p>
						<p class="font-medium text-text-primary mt-0.5">{{ data.campaignSubject }}</p>
						<div v-if="data.selectedTemplate" class="mt-2 flex items-center gap-2">
							<span class="text-sm text-text-secondary">{{
								t('components.campaigns.steps.reviewStep.template')
							}}</span>
							<span class="text-sm text-text-primary">{{ data.selectedTemplate.name }}</span>
						</div>
					</div>
				</div>
				<button
					class="p-2 text-text-tertiary hover:text-text-primary hover:bg-bg-surface-hover rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					@click="emit('editStep', 'content')"
					:aria-label="t('common.edit')"
				>
					<Icon name="lucide:pencil" class="w-4 h-4" />
				</button>
			</div>
			<!-- Under the header, not inside it, so a phone gets the card's full width. -->
			<div v-if="data.selectedTemplate" class="mt-3 sm:pl-11">
				<CampaignsEmailBodyPreview
					v-if="data.emailBodyHtml"
					:html="data.emailBodyHtml"
					:title="t('components.campaigns.steps.reviewStep.previewFrameTitle')"
				/>
				<p
					v-else-if="data.emailBodyHtml === null"
					class="flex items-center gap-2 text-sm text-warning"
					data-testid="review-empty-body"
				>
					<Icon name="lucide:alert-circle" class="h-4 w-4 shrink-0" />
					{{ t('components.campaigns.steps.reviewStep.emptyBody') }}
				</p>
				<CampaignsChangedSinceLastSend :template-id="data.selectedTemplate._id" class="mt-3" />
				<UiButton
					variant="secondary"
					size="sm"
					class="mt-3"
					data-testid="review-edit-email"
					@click="emit('editEmail')"
				>
					<template #iconLeft><Icon name="lucide:pen-line" class="w-4 h-4" /></template>
					{{ t('components.campaigns.steps.reviewStep.editEmail') }}
				</UiButton>
			</div>
		</div>

		<!-- A/B Test Summary -->
		<ReviewAbTestSummary
			v-if="data.abTestEnabled"
			:data="data"
			@edit-step="emit('editStep', $event)"
			@retry-templates="emit('retryTemplates')"
		/>
	</div>
</template>
