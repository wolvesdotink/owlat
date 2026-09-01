<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { Audience } from '@owlat/shared';
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.campaigns.new.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
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

// The step list carries message KEYS; the rendered copy is derived below so it
// follows a locale switch instead of freezing at setup.
const steps = [
	{ id: 'setup' as Step, label: 'dashboard.campaigns.new.steps.setup', number: 1 },
	{ id: 'content' as Step, label: 'dashboard.campaigns.new.steps.content', number: 2 },
	{ id: 'review' as Step, label: 'dashboard.campaigns.new.steps.review', number: 3 },
];

const displaySteps = computed(() => steps.map((step) => ({ ...step, label: t(step.label) })));

// Campaign state. The draft id rides in the URL alongside the step, so a
// refresh, a Back or a shared link reopens the same half-built campaign
// instead of stranding the row the wizard already created.
const initialCampaignId = route.query['id'];
const campaignId = ref<Id<'campaigns'> | null>(
	typeof initialCampaignId === 'string' && initialCampaignId
		? (initialCampaignId as Id<'campaigns'>)
		: null
);

const rememberCampaign = async (id: Id<'campaigns'> | null) => {
	campaignId.value = id;
	const query = { ...route.query };
	if (id) query['id'] = id;
	else delete query['id'];
	await router.replace({ query });
};

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
//
// The step now lives in the URL, but that fallback chain STAYS: SetupStep does
// not rehydrate its own form fields from the persisted campaign (only the
// sender preselect and the A/B expander read it back), so dropping KeepAlive
// would blank the name and reply-to on the way back from Content. Hydrating
// SetupStep from `campaignDetails` is the prerequisite, not this page.
const { data: campaignDetails, error: campaignError } = useConvexQuery(
	api.campaigns.campaigns.getWithRelations,
	() => (campaignId.value ? { campaignId: campaignId.value } : 'skip')
);

// An `?id=` that does not resolve (deleted draft, hand-edited link, another
// org's campaign) leaves the wizard pointing at nothing: drop it and let the
// step validation below fall back to Setup.
watch(campaignError, (error) => {
	if (error) void rememberCampaign(null);
});
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

// A step is reachable once the one before it has been persisted: Setup ends by
// creating the campaign row, Content ends by attaching the email. That is what a
// pasted or stale `?step=` is measured against.
const isStepComplete = (step: Step) => {
	if (step === 'setup') return campaignId.value !== null;
	if (step === 'content') return Boolean(campaignDetails.value?.emailTemplateId);
	return false;
};

// …but only once the draft behind `?id=` has actually arrived. Judging a link
// against a query that has not resolved yet would rewrite `?step=review` to
// Setup in the first frame after a refresh.
const isWizardReady = () =>
	campaignId.value === null || campaignDetails.value !== undefined || campaignError.value !== null;

const { currentStep, getStepStatus, isConnectorHighlighted, goToStep, goToNext, goToPrevious } =
	useWizard(steps, { syncQuery: true, isStepComplete, isReady: isWizardReady });

// Handle step submissions
const handleSetupSubmit = async (newCampaignId: Id<'campaigns'>) => {
	// Awaited so the id is in the query before the step push copies it forward.
	await rememberCampaign(newCampaignId);
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

// Leaving mid-wizard drops whatever the current step has not persisted yet, so
// it asks first — the same guard the editors use, armed the moment there is
// something to lose and disarmed the moment the campaign goes out.
const {
	showDialog: showLeaveDialog,
	confirmDiscard,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges();

const isCampaignSent = ref(false);

const hasSetupInput = computed(() => {
	const form = setupStepRef.value?.form;
	if (!form) return false;
	return Boolean(
		form.campaignName?.trim() ||
			form.fromName?.trim() ||
			form.fromEmail?.trim() ||
			form.replyTo?.trim()
	);
});

const hasWizardProgress = computed(
	() => !isCampaignSent.value && (campaignId.value !== null || hasSetupInput.value)
);

watch(hasWizardProgress, (value) => setHasChanges(value), { immediate: true });

const handleComplete = () => {
	// Campaign sent/scheduled successfully, will redirect via ReviewStep — the
	// wizard has nothing left to protect.
	isCampaignSent.value = true;
	setHasChanges(false);
};

// Computed data for review step. Step refs win when their step is still mounted
// (so live edits show), but everything falls back to the persisted campaign so
// the summary is populated at review time when the sibling steps are deactivated.
const reviewData = computed(() => {
	const setup = setupStepRef.value;
	const content = contentStepRef.value;
	const c = campaignDetails.value;
	const cfg = c?.abTestConfig;

	let audienceDisplayText = t('dashboard.campaigns.new.audience.notConfigured');
	if (setup?.audience?.kind === 'topic' && setup.selectedTopicName) {
		audienceDisplayText = t('dashboard.campaigns.new.audience.topic', {
			name: setup.selectedTopicName,
		});
	} else if (setup?.audience?.kind === 'segment' && setup.selectedSegment) {
		audienceDisplayText = t('dashboard.campaigns.new.audience.segment', {
			name: setup.selectedSegment.name,
		});
	} else if (c?.topic) {
		audienceDisplayText = t('dashboard.campaigns.new.audience.topic', { name: c.topic.name });
	} else if (c?.segment) {
		audienceDisplayText = t('dashboard.campaigns.new.audience.segment', { name: c.segment.name });
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
						:aria-label="t('common.back')"
						@click="handleCancel"
					>
						<Icon name="lucide:arrow-left" class="w-5 h-5" />
					</button>
					<div>
						<h1 class="text-lg font-semibold text-text-primary">
							{{ t('dashboard.campaigns.new.title') }}
						</h1>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.campaigns.new.subtitle') }}
						</p>
					</div>
				</div>
			</div>
		</div>

		<!-- Step Indicator -->
		<div class="bg-bg-elevated border-b border-border-subtle">
			<div class="max-w-4xl mx-auto px-6 py-4">
				<UiStepIndicator
					:steps="displaySteps"
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

		<UiConfirmationDialog
			:open="showLeaveDialog"
			:title="t('dashboard.campaigns.new.leaveDialog.title')"
			:description="t('dashboard.campaigns.new.leaveDialog.description')"
			:confirm-text="t('dashboard.campaigns.new.leaveDialog.confirm')"
			:cancel-text="t('dashboard.campaigns.new.leaveDialog.cancel')"
			@update:open="cancelNavigation"
			@confirm="confirmDiscard"
		/>
	</div>
</template>
