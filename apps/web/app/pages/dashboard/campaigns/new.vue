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

// Wizard steps — a simple campaign is three screens. The A/B test lives inside
// the Setup step as an optional expander, so it is never seen unless added.
type Step = 'setup' | 'content' | 'review';
type EmailTemplateSummary = {
	_id: Id<'emailTemplates'>;
	name: string;
	subject: string;
};

const steps = [
	{ id: 'setup' as Step, label: 'Setup', number: 1 },
	{ id: 'content' as Step, label: 'Content', number: 2 },
	{ id: 'review' as Step, label: 'Review', number: 3 },
];

const { currentStep, getStepStatus, isConnectorHighlighted, goToStep, goToNext, goToPrevious } =
	useWizard(steps);

// Campaign state
const campaignId = ref<Id<'campaigns'> | null>(null);

type SetupStepExpose = {
	form?: {
		campaignName?: string;
		fromName?: string;
		fromEmail?: string;
		replyTo?: string;
	};
	audience?: Audience | null;
	audienceCount?: { eligible: number; total: number } | null;
	selectedTopicName?: string | null;
	selectedSegment?: { name: string } | null;
	abTestEnabled?: boolean;
	abTestType?: 'subject' | 'content';
	abVariantBSubject?: string;
	abVariantBTemplateId?: Id<'emailTemplates'> | null;
	abSplitPercentage?: number;
	abWinnerCriteria?: 'open_rate' | 'click_rate' | 'manual';
	abTestDuration?: number;
};

type ContentStepExpose = {
	campaignSubject?: string;
	selectedTemplate?: EmailTemplateSummary | null;
};

const setupStepRef = ref<SetupStepExpose | null>(null);
const contentStepRef = ref<ContentStepExpose | null>(null);

// The step components are wrapped in <KeepAlive>, so their instances survive
// step navigation (typed values and the A/B expander persist). A deactivated
// step's template ref is still nulled, so the review summary falls back to the
// canonical campaign persisted on each step's Next.
const { data: campaignDetails } = useConvexQuery(api.campaigns.campaigns.getWithRelations, () =>
	campaignId.value ? { campaignId: campaignId.value } : 'skip'
);
const { data: recipientCount } = useConvexQuery(
	api.campaigns.audienceResolution.countRecipients,
	() => (campaignDetails.value?.audience ? { audience: campaignDetails.value.audience } : 'skip')
);
const persistedTemplate = computed(() => campaignDetails.value?.emailTemplate ?? null);

// Templates power the review step's A/B variant-B name lookup.
const { results: emailTemplates } = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => {
		if (authPending.value || !isAuthenticated.value) return 'skip';
		return { type: 'marketing' as const };
	},
	{ initialNumItems: 100 }
);

// Handle step submissions
const handleSetupSubmit = (newCampaignId: Id<'campaigns'>) => {
	campaignId.value = newCampaignId;
	goToNext();
};

const handleContentSubmit = () => {
	goToNext();
};

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
// the summary is populated at review time when the sibling steps are deactivated.
const reviewData = computed(() => {
	const setup = setupStepRef.value;
	const content = contentStepRef.value;
	const c = campaignDetails.value;
	const cfg = c?.abTestConfig;

	let audienceDisplayText = 'Not configured';
	if (setup?.audience?.kind === 'topic' && setup.selectedTopicName) {
		audienceDisplayText = `Topic: ${setup.selectedTopicName}`;
	} else if (setup?.audience?.kind === 'segment' && setup.selectedSegment) {
		audienceDisplayText = `Segment: ${setup.selectedSegment.name}`;
	} else if (c?.topic) {
		audienceDisplayText = `Topic: ${c.topic.name}`;
	} else if (c?.segment) {
		audienceDisplayText = `Segment: ${c.segment.name}`;
	}

	return {
		campaignId: campaignId.value!,
		campaignName: setup?.form?.campaignName ?? c?.name ?? '',
		fromName: setup?.form?.fromName ?? c?.fromName ?? '',
		fromEmail: setup?.form?.fromEmail ?? c?.fromEmail ?? '',
		replyTo: setup?.form?.replyTo ?? c?.replyTo ?? '',
		audienceDisplayText,
		audienceCount: setup?.audienceCount?.eligible ?? recipientCount.value?.eligible ?? 0,
		campaignSubject: content?.campaignSubject ?? c?.subject ?? '',
		selectedTemplate: content?.selectedTemplate ?? persistedTemplate.value,
		abTestEnabled: setup?.abTestEnabled ?? !!cfg,
		abTestType: setup?.abTestType ?? cfg?.testType ?? 'subject',
		abVariantBSubject: setup?.abVariantBSubject ?? cfg?.variantBSubject ?? '',
		abVariantBTemplateId:
			setup?.abVariantBTemplateId ??
			(cfg?.variantBTemplateId as Id<'emailTemplates'> | undefined) ??
			null,
		abSplitPercentage: setup?.abSplitPercentage ?? cfg?.splitPercentage ?? 20,
		abWinnerCriteria: setup?.abWinnerCriteria ?? cfg?.winnerCriteria ?? 'open_rate',
		abTestDuration: setup?.abTestDuration ?? cfg?.testDuration ?? 4,
		templates: emailTemplates.value ?? [],
	};
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
						aria-label="Back"
						@click="handleCancel"
					>
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
			<KeepAlive>
				<CampaignsStepsSetupStep
					v-if="currentStep === 'setup'"
					ref="setupStepRef"
					:campaign-id="campaignId"
					@submit="handleSetupSubmit"
					@cancel="handleCancel"
				/>

				<CampaignsStepsContentStep
					v-else-if="currentStep === 'content' && campaignId"
					ref="contentStepRef"
					:campaign-id="campaignId"
					@submit="handleContentSubmit"
					@back="goToPrevious"
				/>

				<CampaignsStepsReviewStep
					v-else-if="currentStep === 'review' && campaignId"
					:data="reviewData"
					@back="goToPrevious"
					@edit-step="handleEditStep"
					@complete="handleComplete"
				/>
			</KeepAlive>
		</div>
	</div>
</template>
