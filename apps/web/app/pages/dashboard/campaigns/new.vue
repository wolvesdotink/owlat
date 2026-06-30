<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { Audience } from '@owlat/shared';
import { api } from '@owlat/api';

useHead({ title: 'Create Campaign — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
useOrganizationContext();
const { isPending: authPending, isAuthenticated } = useAuth();

// Wizard steps
type Step = 'basics' | 'audience' | 'content' | 'abtest' | 'review';
type EmailTemplateSummary = {
	_id: Id<'emailTemplates'>;
	name: string;
	subject: string;
};

const steps = [
	{ id: 'basics' as Step, label: 'Basics', number: 1 },
	{ id: 'audience' as Step, label: 'Audience', number: 2 },
	{ id: 'content' as Step, label: 'Content', number: 3 },
	{ id: 'abtest' as Step, label: 'A/B Test', number: 4 },
	{ id: 'review' as Step, label: 'Review', number: 5 },
];

const { currentStep, getStepStatus, isConnectorHighlighted, goToStep, goToNext, goToPrevious } =
	useWizard(steps);

// Campaign state
const campaignId = ref<Id<'campaigns'> | null>(null);

type BasicsStepExpose = {
	form?: {
		campaignName?: string;
		fromName?: string;
		fromEmail?: string;
		replyTo?: string;
	};
};

type AudienceStepExpose = {
	audience?: Audience | null;
	selectedTopicName?: string | null;
	selectedSegment?: { name: string } | null;
	audienceCount?: { eligible: number; total: number } | null;
};

type ContentStepExpose = {
	campaignSubject?: string;
	selectedTemplate?: EmailTemplateSummary | null;
	filteredTemplates?: EmailTemplateSummary[];
};

type ABTestStepExpose = {
	abTestEnabled?: boolean;
	abTestType?: 'subject' | 'content';
	abVariantBSubject?: string;
	abVariantBTemplateId?: Id<'emailTemplates'> | null;
	abSplitPercentage?: number;
	abWinnerCriteria?: 'open_rate' | 'click_rate' | 'manual';
	abTestDuration?: number;
};

const basicsStepRef = ref<BasicsStepExpose | null>(null);
const audienceStepRef = ref<AudienceStepExpose | null>(null);
const contentStepRef = ref<ContentStepExpose | null>(null);
const abTestStepRef = ref<ABTestStepExpose | null>(null);

// Query for email templates (needed for A/B test step)
const { results: emailTemplates } = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => {
		if (authPending.value || !isAuthenticated.value) return 'skip';
		return { type: 'marketing' as const };
	},
	{ initialNumItems: 100 }
);

// The wizard renders steps with mutually-exclusive v-if (no <KeepAlive>), so by
// the time the user reaches the A/B and Review steps the earlier step refs are
// unmounted (null) and the summary read blank. Each step persists to the
// campaign on Next, so source the canonical values from the backend instead.
const { data: campaignDetails } = useConvexQuery(
	api.campaigns.campaigns.getWithRelations,
	() => (campaignId.value ? { campaignId: campaignId.value } : 'skip')
);
const { data: recipientCount } = useConvexQuery(
	api.campaigns.audienceResolution.countRecipients,
	() => (campaignDetails.value?.audience ? { audience: campaignDetails.value.audience } : 'skip')
);
// Template chosen on the Content step — resolved from the persisted campaign so
// the A/B step's "Variant A (Original)" + same-template guard work after Content
// unmounts.
const persistedTemplate = computed(() => campaignDetails.value?.emailTemplate ?? null);

// Handle step submissions
const handleBasicsSubmit = (newCampaignId: Id<'campaigns'>) => {
	campaignId.value = newCampaignId;
	goToNext();
};

const handleAudienceSubmit = () => {
	goToNext();
};

const handleContentSubmit = () => {
	goToNext();
};

const handleABTestSubmit = () => {
	goToNext();
};

// Handle navigation
const handleCancel = () => {
	router.push('/dashboard/campaigns');
};

const handleEditStep = (step: string) => {
	goToStep(step as Step);
};

const handleComplete = () => {
	// Campaign sent/scheduled successfully, will redirect via ReviewStep
};

// Computed data for review step. Step refs win when their step is still mounted
// (so live edits show), but everything falls back to the persisted campaign so
// the summary is populated at review time when the sibling steps are unmounted.
const reviewData = computed(() => {
	const basics = basicsStepRef.value?.form;
	const audienceStep = audienceStepRef.value;
	const content = contentStepRef.value;
	const abTest = abTestStepRef.value;
	const c = campaignDetails.value;
	const cfg = c?.abTestConfig;

	// Audience display text — read from the shared Audience value (ADR-0033),
	// falling back to the persisted topic/segment join.
	let audienceDisplayText = 'Not configured';
	if (audienceStep?.audience?.kind === 'topic' && audienceStep.selectedTopicName) {
		audienceDisplayText = `Topic: ${audienceStep.selectedTopicName}`;
	} else if (audienceStep?.audience?.kind === 'segment' && audienceStep.selectedSegment) {
		audienceDisplayText = `Segment: ${audienceStep.selectedSegment.name}`;
	} else if (c?.topic) {
		audienceDisplayText = `Topic: ${c.topic.name}`;
	} else if (c?.segment) {
		audienceDisplayText = `Segment: ${c.segment.name}`;
	}

	return {
		campaignId: campaignId.value!,
		campaignName: basics?.campaignName ?? c?.name ?? '',
		fromName: basics?.fromName ?? c?.fromName ?? '',
		fromEmail: basics?.fromEmail ?? c?.fromEmail ?? '',
		replyTo: basics?.replyTo ?? c?.replyTo ?? '',
		audienceDisplayText,
		audienceCount: audienceStep?.audienceCount?.eligible ?? recipientCount.value?.eligible ?? 0,
		campaignSubject: content?.campaignSubject ?? c?.subject ?? '',
		selectedTemplate: content?.selectedTemplate ?? persistedTemplate.value,
		abTestEnabled: abTest?.abTestEnabled ?? !!cfg,
		abTestType: abTest?.abTestType ?? cfg?.testType ?? 'subject',
		abVariantBSubject: abTest?.abVariantBSubject ?? cfg?.variantBSubject ?? '',
		abVariantBTemplateId:
			abTest?.abVariantBTemplateId ?? (cfg?.variantBTemplateId as Id<'emailTemplates'> | undefined) ?? null,
		abSplitPercentage: abTest?.abSplitPercentage ?? cfg?.splitPercentage ?? 20,
		abWinnerCriteria: abTest?.abWinnerCriteria ?? cfg?.winnerCriteria ?? 'open_rate',
		abTestDuration: abTest?.abTestDuration ?? cfg?.testDuration ?? 4,
		templates: emailTemplates.value ?? [],
	};
});

// Filtered templates for A/B test step
const filteredTemplates = computed(() => {
	return contentStepRef.value?.filteredTemplates ?? emailTemplates.value ?? [];
});
</script>

<template>
	<div class="min-h-full bg-bg-base">
		<!-- Header -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<div class="flex items-center gap-4">
					<button
						class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
						@click="handleCancel"
					 aria-label="Back">
						<Icon name="lucide:arrow-left" class="w-5 h-5" />
					</button>
					<div>
						<h1 class="text-lg font-semibold text-text-primary">Create Campaign</h1>
						<p class="text-sm text-text-secondary">Set up your email campaign</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Step Indicator -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<UiStepIndicator
					:steps="steps"
					:get-step-status="
						getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'
					"
					:is-connector-highlighted="isConnectorHighlighted"
				/>
			</div>
		</div>

		<!-- Content -->
		<div class="max-w-4xl mx-auto px-6 py-8">
			<!-- Step 1: Basics -->
			<CampaignsStepsBasicsStep
				v-if="currentStep === 'basics'"
				ref="basicsStepRef"
				:campaign-id="campaignId"
				@submit="handleBasicsSubmit"
				@cancel="handleCancel"
			/>

			<!-- Step 2: Audience -->
			<CampaignsStepsAudienceStep
				v-else-if="currentStep === 'audience' && campaignId"
				ref="audienceStepRef"
				:campaign-id="campaignId"
				@submit="handleAudienceSubmit"
				@back="goToPrevious"
			/>

			<!-- Step 3: Content -->
			<CampaignsStepsContentStep
				v-else-if="currentStep === 'content' && campaignId"
				ref="contentStepRef"
				:campaign-id="campaignId"
				@submit="handleContentSubmit"
				@back="goToPrevious"
			/>

			<!-- Step 4: A/B Test -->
			<CampaignsStepsABTestStep
				v-else-if="currentStep === 'abtest' && campaignId"
				ref="abTestStepRef"
				:campaign-id="campaignId"
				:campaign-subject="contentStepRef?.campaignSubject ?? ''"
				:selected-template="contentStepRef?.selectedTemplate ?? persistedTemplate"
				:templates="filteredTemplates"
				@submit="handleABTestSubmit"
				@back="goToPrevious"
			/>

			<!-- Step 5: Review -->
			<CampaignsStepsReviewStep
				v-else-if="currentStep === 'review' && campaignId"
				:data="reviewData"
				@back="goToPrevious"
				@edit-step="handleEditStep"
				@complete="handleComplete"
			/>
		</div>
	</div>
</template>
