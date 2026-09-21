<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { rules } from '~/composables/useFormValidation';

type AudienceType = 'topic' | 'segment';

// The exposed API of the extracted sender picker: a validate() that sets its own
// error state and returns a human message (or null), plus a readiness flag for
// the submit button.
interface SenderPickerApi {
	validate: () => string | null;
	isReady: boolean;
}

interface Props {
	campaignId: Id<'campaigns'> | null;
}

const { t } = useI18n();

const props = defineProps<Props>();

const emit = defineEmits<{
	submit: [campaignId: Id<'campaigns'>];
	cancel: [];
}>();

const { isPending: authPending, isAuthenticated } = useAuth();

// --- Basics -----------------------------------------------------------------
const form = reactive({
	campaignName: '',
	fromName: '',
	fromEmail: '',
	replyTo: '',
});

// From-name / from-email are chosen through the sender picker (curated senders
// carry their own identity; the custom branch validates below), so the base
// schema only owns the two always-free-text fields.
// The messages resolve when the rule RUNS, not when the schema is built, so a
// locale switch between mount and submit still validates in the active locale.
const basicsValidation = useFormValidation({
	campaignName: [
		(value) => rules.required(t('components.campaigns.steps.setupStep.errors.nameRequired'))(value),
	],
	replyTo: [
		(value) => rules.email(t('components.campaigns.steps.setupStep.errors.replyToInvalid'))(value),
	],
});

// The persisted campaign backs the sender preselect (below) and the A/B
// expander (further down); declared here so the sender init watcher can read it.
const { data: campaignDetails } = useConvexQuery(api.campaigns.campaigns.getWithRelations, () =>
	props.campaignId ? { campaignId: props.campaignId } : 'skip'
);

// --- Sender picker ----------------------------------------------------------
// The curated-sender select (query, state, watchers, custom-branch fields and
// the advisory domain check) lives in SetupSenderPicker; it v-models the from
// name/address back into `form` and exposes validate() + isReady through here.
const senderPickerRef = ref<SenderPickerApi | null>(null);

// --- Audience ---------------------------------------------------------------
const audienceType = ref<AudienceType>('topic');
const selectedTopicId = ref<Id<'topics'> | null>(null);
const selectedSegmentId = ref<Id<'segments'> | null>(null);
const audienceError = ref<string | null>(null);

// One discriminated Audience value (ADR-0033) — the single source of truth for
// the count query and the submit mutation. Null until a complete selection.
const audience = computed(() => {
	if (audienceType.value === 'topic' && selectedTopicId.value) {
		return { kind: 'topic' as const, topicId: selectedTopicId.value };
	}
	if (audienceType.value === 'segment' && selectedSegmentId.value) {
		return { kind: 'segment' as const, segmentId: selectedSegmentId.value };
	}
	return null;
});

const { results: topics } = useTopicsList();
const { results: segments } = usePaginatedQuery(api.segments.list, () => ({}), {
	initialNumItems: 100,
});

const { data: audienceCount } = useOrganizationQuery(
	api.campaigns.audienceResolution.countRecipients,
	() => ({ audience: audience.value ?? undefined })
);

const selectedTopicName = computed(() => {
	if (!selectedTopicId.value || !topics.value) return null;
	return topics.value.find((t: { _id: string }) => t._id === selectedTopicId.value)?.name ?? null;
});

const selectedSegment = computed(() => {
	if (!selectedSegmentId.value || !segments.value) return null;
	return segments.value.find((s: { _id: string }) => s._id === selectedSegmentId.value) ?? null;
});

// --- A/B test (optional, progressive-disclosure expander) -------------------
const abTest = useCampaignABTest();
const abTestExpanded = ref(false);

const { results: emailTemplates } = usePaginatedQuery(
	api.emailTemplates.emails.list,
	() => {
		if (authPending.value || !isAuthenticated.value) return 'skip';
		return { type: 'marketing' as const };
	},
	{ initialNumItems: 100 }
);

// Variant A display + the template to exclude from Variant B are sourced from
// the persisted campaign so the expander is meaningful even though the subject
// and template are chosen on the later Content step.
const variantASubject = computed(() => campaignDetails.value?.subject ?? '');
const variantATemplateName = computed(() => campaignDetails.value?.emailTemplate?.name ?? '');
const selectedTemplateId = computed(
	() => (campaignDetails.value?.emailTemplateId as Id<'emailTemplates'> | undefined) ?? null
);

// Seed the A/B expander from an existing campaign draft exactly once.
let abInitialized = false;
watch(
	campaignDetails,
	(campaign) => {
		if (!campaign || abInitialized) return;
		abInitialized = true;
		abTest.initializeFromCampaign(campaign);
		if (campaign.isABTest) abTestExpanded.value = true;
	},
	{ immediate: true }
);

const addABTest = () => {
	abTestExpanded.value = true;
	abTest.abTestEnabled.value = true;
};

const removeABTest = () => {
	abTestExpanded.value = false;
	abTest.abTestEnabled.value = false;
};

// --- Mutations --------------------------------------------------------------
const { run: createCampaign } = useBackendOperation(api.campaigns.campaigns.create, {
	label: () => t('components.campaigns.steps.setupStep.operations.createCampaign'),
});
const { run: updateBasics } = useBackendOperation(api.campaigns.campaigns.updateBasics, {
	label: () => t('components.campaigns.steps.setupStep.operations.updateBasics'),
});
const { run: updateAudience } = useBackendOperation(api.campaigns.campaigns.updateAudience, {
	label: () => t('components.campaigns.steps.setupStep.operations.updateAudience'),
	inlineTarget: audienceError,
});
const { run: enableABTest } = useBackendOperation(api.campaigns.abTest.enableABTest, {
	label: () => t('components.campaigns.steps.setupStep.operations.enableABTest'),
});
const { run: disableABTest } = useBackendOperation(api.campaigns.abTest.disableABTest, {
	label: () => t('components.campaigns.steps.setupStep.operations.disableABTest'),
});

const { isLoading, error, setError, setLoading } = useModal();

// --- Validation + submit ----------------------------------------------------
const validate = (): boolean => {
	setError('');
	audienceError.value = null;

	if (!basicsValidation.validate(form)) return false;

	// The sender picker owns its own validation/error copy and writes fromName /
	// fromEmail back into `form`; a non-null message means the selection is
	// incomplete (mirrors the server gate).
	if (senderPickerRef.value?.validate() != null) return false;

	if (audienceType.value === 'topic' && !selectedTopicId.value) {
		audienceError.value = t('components.campaigns.steps.setupStep.errors.topicRequired');
		return false;
	}
	if (audienceType.value === 'segment' && !selectedSegmentId.value) {
		audienceError.value = t('components.campaigns.steps.setupStep.errors.segmentRequired');
		return false;
	}

	const abError = abTest.validate();
	if (abError) {
		setError(abError);
		return false;
	}

	return true;
};

const handleSubmit = async () => {
	if (!validate()) return;

	setLoading(true);
	try {
		let campaignId = props.campaignId;

		if (!campaignId) {
			const newCampaignId = await createCampaign({ name: form.campaignName.trim() });
			if (!newCampaignId.ok) return;
			campaignId = newCampaignId.result;
		}

		if (
			!(
				await updateBasics({
					campaignId,
					name: form.campaignName.trim(),
					fromName: form.fromName.trim(),
					fromEmail: form.fromEmail.trim(),
					replyTo: form.replyTo.trim() || undefined,
				})
			).ok
		) {
			return;
		}

		if (!(await updateAudience({ campaignId, audience: audience.value! })).ok) {
			return;
		}

		if (abTest.abTestEnabled.value) {
			if (!(await enableABTest(abTest.buildEnablePayload(campaignId))).ok) return;
		} else {
			if (!(await disableABTest({ campaignId })).ok) return;
		}

		emit('submit', campaignId);
	} finally {
		setLoading(false);
	}
};

const canSubmit = computed(() => {
	if (isLoading.value) return false;
	if (!senderPickerRef.value?.isReady) return false;
	if (audienceType.value === 'topic' && !selectedTopicId.value) return false;
	if (audienceType.value === 'segment' && !selectedSegmentId.value) return false;
	return true;
});

// Exposed for the review step's live-edit read (falls back to the persisted
// campaign when this step is deactivated by <KeepAlive>).
defineExpose({
	form,
	audience,
	audienceCount,
	selectedTopicName,
	selectedSegment,
	abTestEnabled: abTest.abTestEnabled,
	abTestType: abTest.abTestType,
	abVariantBSubject: abTest.abVariantBSubject,
	abVariantBTemplateId: abTest.abVariantBTemplateId,
	abSplitPercentage: abTest.abSplitPercentage,
	abWinnerCriteria: abTest.abWinnerCriteria,
	abTestDuration: abTest.abTestDuration,
});
</script>

<template>
	<form class="space-y-6" @submit.prevent="handleSubmit">
		<UiErrorAlert v-if="error" :message="error" />

		<!-- Campaign details -->
		<div class="card p-6">
			<div class="mb-6">
				<h2 class="text-xl font-semibold text-text-primary">
					{{ t('components.campaigns.steps.setupStep.detailsTitle') }}
				</h2>
				<p class="text-text-secondary mt-1">
					{{ t('components.campaigns.steps.setupStep.detailsSubtitle') }}
				</p>
			</div>

			<div class="space-y-6">
				<div>
					<label for="campaignName" class="label flex items-center gap-2">
						<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.campaigns.steps.setupStep.nameLabel') }}
						<span class="text-error">*</span>
					</label>
					<input
						id="campaignName"
						v-model="form.campaignName"
						type="text"
						:placeholder="t('components.campaigns.steps.setupStep.namePlaceholder')"
						:class="[
							'input mt-1.5',
							basicsValidation.hasError('campaignName') ? 'input-error' : '',
						]"
					/>
					<p
						v-if="basicsValidation.getError('campaignName', true)"
						class="mt-1.5 text-sm text-error"
					>
						{{ basicsValidation.getError('campaignName', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						{{ t('components.campaigns.steps.setupStep.nameHint') }}
					</p>
				</div>

				<CampaignsStepsSetupSenderPicker
					ref="senderPickerRef"
					v-model:from-name="form.fromName"
					v-model:from-email="form.fromEmail"
					:campaign-id="campaignId"
					:campaign-details="campaignDetails"
				/>

				<div>
					<label for="replyTo" class="label flex items-center gap-2">
						<Icon name="lucide:reply" class="w-4 h-4 text-text-tertiary" />
						<I18nT
							keypath="components.campaigns.steps.setupStep.replyToLabel"
							tag="span"
							scope="global"
						>
							<template #optional>
								<span class="text-text-tertiary">{{
									t('components.campaigns.steps.setupStep.optional')
								}}</span>
							</template>
						</I18nT>
					</label>
					<input
						id="replyTo"
						v-model="form.replyTo"
						type="email"
						:placeholder="t('components.campaigns.steps.setupStep.replyToPlaceholder')"
						:class="['input mt-1.5', basicsValidation.hasError('replyTo') ? 'input-error' : '']"
					/>
					<p v-if="basicsValidation.getError('replyTo', true)" class="mt-1.5 text-sm text-error">
						{{ basicsValidation.getError('replyTo', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						{{ t('components.campaigns.steps.setupStep.replyToHint') }}
					</p>
				</div>
			</div>
		</div>

		<!-- Audience -->
		<CampaignsStepsSetupAudiencePicker
			v-model:audience-type="audienceType"
			v-model:selected-topic-id="selectedTopicId"
			v-model:selected-segment-id="selectedSegmentId"
			:topics="topics ?? null"
			:segments="segments ?? null"
			:audience-count="audienceCount ?? null"
			:error="audienceError"
		/>

		<!-- Optional A/B test expander -->
		<div v-if="!abTestExpanded" class="card p-6">
			<button
				type="button"
				class="flex w-full items-center gap-2 text-left text-text-primary font-medium hover:opacity-80 transition-opacity"
				@click="addABTest"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.campaigns.steps.setupStep.addABTest') }}
			</button>
			<p class="mt-1 text-sm text-text-tertiary">
				{{ t('components.campaigns.steps.setupStep.addABTestHint') }}
			</p>
		</div>
		<div v-else>
			<CampaignsABTestConfig
				v-model:ab-test-enabled="abTest.abTestEnabled.value"
				v-model:ab-test-type="abTest.abTestType.value"
				v-model:ab-variant-b-subject="abTest.abVariantBSubject.value"
				v-model:ab-variant-b-template-id="abTest.abVariantBTemplateId.value"
				v-model:ab-split-percentage="abTest.abSplitPercentage.value"
				v-model:ab-winner-criteria="abTest.abWinnerCriteria.value"
				v-model:ab-test-duration="abTest.abTestDuration.value"
				:campaign-subject="variantASubject"
				:selected-template-name="variantATemplateName"
				:email-templates="emailTemplates"
				:selected-template-id="selectedTemplateId"
			/>
			<button
				type="button"
				class="mt-3 text-sm text-text-tertiary hover:text-text-primary transition-colors"
				@click="removeABTest"
			>
				{{ t('components.campaigns.steps.setupStep.removeABTest') }}
			</button>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-between pt-2">
			<UiButton variant="secondary" @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
			<UiButton type="submit" :loading="isLoading" :disabled="!canSubmit">
				{{ isLoading ? t('common.saving') : t('common.next') }}
				<template v-if="!isLoading" #iconRight>
					<Icon name="lucide:arrow-right" class="w-4 h-4" />
				</template>
			</UiButton>
		</div>
	</form>
</template>
