<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { rules } from '~/composables/useFormValidation';
import { isValidEmail } from '~/utils/validation';
import {
	CUSTOM_SENDER_VALUE,
	buildSenderOptions,
	defaultSenderValue,
	isCustomSender,
	senderSelectionProblem,
} from '~/utils/campaignSenderPicker';

type AudienceType = 'topic' | 'segment';

interface Props {
	campaignId: Id<'campaigns'> | null;
}

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
const basicsValidation = useFormValidation({
	campaignName: [rules.required('Campaign name is required')],
	replyTo: [rules.email('Please enter a valid email address')],
});

// The persisted campaign backs the sender preselect (below) and the A/B
// expander (further down); declared here so the sender init watcher can read it.
const { data: campaignDetails } = useConvexQuery(api.campaigns.campaigns.getWithRelations, () =>
	props.campaignId ? { campaignId: props.campaignId } : 'skip'
);

// --- Sender picker ----------------------------------------------------------
// Enabled curated senders + the custom-address toggle + whether this user may
// manage the list (drives the empty-state copy). Any org member who reaches the
// wizard can read this.
const {
	data: senderPicker,
	isLoading: senderPickerLoading,
	error: senderPickerError,
} = useOrganizationQuery(api.campaigns.senders.listForPicker);

const senders = computed(() => senderPicker.value?.senders ?? []);
const isCustomAllowed = computed(() => senderPicker.value?.isCustomAllowed === true);
const canManageSenders = computed(() => senderPicker.value?.canManage === true);

const selectedSenderId = ref<string>('');
const senderError = ref<string | null>(null);
// Which custom field the current senderError flags (drives the input-error ring
// on the matching From Name / From Email input); null when the error is not
// field-specific (e.g. nothing selected).
const senderErrorField = ref<'name' | 'email' | null>(null);

const senderOptions = computed(() => buildSenderOptions(senders.value, isCustomAllowed.value));
const isCustomSelected = computed(() => isCustomSender(selectedSenderId.value));

// No curated senders AND no custom escape hatch: nothing is selectable, so show
// an empty-state (admin deep link vs. "ask your admin") instead of a picker.
const showSenderEmptyState = computed(() => senders.value.length === 0 && !isCustomAllowed.value);

const isSenderReady = computed(
	() =>
		senderSelectionProblem(selectedSenderId.value, {
			fromName: form.fromName,
			fromEmail: form.fromEmail,
		}) === null
);

function onSelectSender(value: string | null) {
	selectedSenderId.value = value ?? '';
	senderError.value = null;
	senderErrorField.value = null;
}

// A curated selection is the source of truth for the from name/address; keep the
// form fields (read by defineExpose / the review summary) in sync. The custom
// branch leaves the fields for the user to edit.
watch(selectedSenderId, (value) => {
	if (value === CUSTOM_SENDER_VALUE || !value) return;
	const sender = senders.value.find((s) => s._id === value);
	if (sender) {
		form.fromName = sender.displayName ?? '';
		form.fromEmail = sender.email;
	}
});

// One-shot preselect once the picker (and, when editing, the persisted campaign)
// has loaded: reuse the campaign's saved sender if it still matches a curated
// row, fall back to the custom branch when allowed, else the default sender.
let senderInitialized = false;
watch(
	[senders, isCustomAllowed, campaignDetails],
	() => {
		if (senderInitialized || !senderPicker.value) return;
		if (props.campaignId && campaignDetails.value === undefined) return;
		senderInitialized = true;

		const existingEmail = campaignDetails.value?.fromEmail?.trim().toLowerCase();
		if (existingEmail) {
			const match = senders.value.find((s) => s.email === existingEmail);
			if (match) {
				selectedSenderId.value = match._id;
				return;
			}
			if (isCustomAllowed.value) {
				selectedSenderId.value = CUSTOM_SENDER_VALUE;
				form.fromName = campaignDetails.value?.fromName ?? '';
				form.fromEmail = campaignDetails.value?.fromEmail ?? '';
				return;
			}
		}
		selectedSenderId.value = defaultSenderValue(senders.value, isCustomAllowed.value);
	},
	{ immediate: true }
);

// Advisory only — curated senders are already domain-verified, so the wizard's
// live domain check applies to the custom branch. The server keeps the hard
// verified-domain floor at send time.
const { data: domainVerificationStatus } = useOrganizationQuery(
	api.domains.domains.getEmailDomainVerificationStatus,
	() => {
		if (!isCustomSelected.value) return undefined;
		const email = form.fromEmail.trim();
		if (!email || !isValidEmail(email)) return undefined;
		return { email };
	}
);

const domainVerificationWarning = computed(() => {
	const status = domainVerificationStatus.value;
	if (!status) return null;
	if (!status.exists) {
		return `Domain "${status.domain}" is not registered. You can continue editing, but sending is disabled until you add and verify this domain in Settings > Domains.`;
	}
	if (!status.verified) {
		return `Domain "${status.domain}" is not verified. You can continue editing, but sending is disabled until DNS verification completes in Settings > Domains.`;
	}
	if (status.stale) {
		return `Domain verification is stale (last checked ${status.lastVerifiedAt ? new Date(status.lastVerifiedAt).toLocaleDateString() : 'never'}). Consider re-verifying.`;
	}
	return null;
});

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
	label: 'Create campaign',
});
const { run: updateBasics } = useBackendOperation(api.campaigns.campaigns.updateBasics, {
	label: 'Update campaign basics',
});
const { run: updateAudience } = useBackendOperation(api.campaigns.campaigns.updateAudience, {
	label: 'Update campaign audience',
	inlineTarget: audienceError,
});
const { run: enableABTest } = useBackendOperation(api.campaigns.abTest.enableABTest, {
	label: 'Enable A/B test',
});
const { run: disableABTest } = useBackendOperation(api.campaigns.abTest.disableABTest, {
	label: 'Disable A/B test',
});

const { isLoading, error, setError, setLoading } = useModal();

// --- Validation + submit ----------------------------------------------------
const validate = (): boolean => {
	setError('');
	audienceError.value = null;
	senderError.value = null;
	senderErrorField.value = null;

	if (!basicsValidation.validate(form)) return false;

	// One source of truth for the guard AND the messages: map the util's
	// discriminated reason to human copy (the util already mirrors the server gate).
	const problem = senderSelectionProblem(selectedSenderId.value, {
		fromName: form.fromName,
		fromEmail: form.fromEmail,
	});
	if (problem === 'none-selected') {
		senderError.value = 'Choose who this campaign sends from';
		return false;
	}
	if (problem === 'missing-name') {
		senderError.value = 'Enter a from name';
		senderErrorField.value = 'name';
		return false;
	}
	if (problem === 'invalid-email') {
		senderError.value = 'Enter a valid from address';
		senderErrorField.value = 'email';
		return false;
	}

	if (audienceType.value === 'topic' && !selectedTopicId.value) {
		audienceError.value = 'Please select a topic';
		return false;
	}
	if (audienceType.value === 'segment' && !selectedSegmentId.value) {
		audienceError.value = 'Please select a segment';
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
			if (!newCampaignId) return;
			campaignId = newCampaignId;
		}

		if (
			(await updateBasics({
				campaignId,
				name: form.campaignName.trim(),
				fromName: form.fromName.trim(),
				fromEmail: form.fromEmail.trim(),
				replyTo: form.replyTo.trim() || undefined,
			})) === undefined
		) {
			return;
		}

		if ((await updateAudience({ campaignId, audience: audience.value! })) === undefined) {
			return;
		}

		if (abTest.abTestEnabled.value) {
			if ((await enableABTest(abTest.buildEnablePayload(campaignId))) === undefined) return;
		} else {
			if ((await disableABTest({ campaignId })) === undefined) return;
		}

		emit('submit', campaignId);
	} finally {
		setLoading(false);
	}
};

const canSubmit = computed(() => {
	if (isLoading.value) return false;
	if (!isSenderReady.value) return false;
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
				<h2 class="text-xl font-semibold text-text-primary">Campaign Details</h2>
				<p class="text-text-secondary mt-1">Name your campaign and set the sender.</p>
			</div>

			<div class="space-y-6">
				<div>
					<label for="campaignName" class="label flex items-center gap-2">
						<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
						Campaign Name <span class="text-error">*</span>
					</label>
					<input
						id="campaignName"
						v-model="form.campaignName"
						type="text"
						placeholder="e.g., Summer Newsletter 2026"
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
						This name is for your reference and won't be visible to recipients.
					</p>
				</div>

				<div>
					<label for="senderPicker" class="label flex items-center gap-2">
						<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
						Send from <span class="text-error">*</span>
					</label>

					<!-- Loading -->
					<p v-if="senderPickerLoading && !senderPicker" class="mt-1.5 text-sm text-text-tertiary">
						Loading senders…
					</p>

					<!-- Error -->
					<UiErrorAlert
						v-else-if="senderPickerError"
						class="mt-1.5"
						message="Could not load campaign senders. Please try again."
					/>

					<!-- Empty: no curated senders and custom addresses aren't allowed -->
					<div
						v-else-if="showSenderEmptyState"
						class="mt-1.5 rounded-lg border border-border-subtle bg-bg-surface p-4 text-sm"
					>
						<p class="text-text-secondary">No campaign senders have been set up yet.</p>
						<NuxtLink
							v-if="canManageSenders"
							to="/dashboard/settings/campaign-senders"
							class="mt-2 inline-flex items-center gap-1.5 font-medium text-brand hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand rounded"
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add a campaign sender
						</NuxtLink>
						<p v-else class="mt-1 text-text-tertiary">
							Ask your admin to add a campaign sender before you can send.
						</p>
					</div>

					<!-- Picker -->
					<template v-else>
						<UiSelect
							id="senderPicker"
							class="mt-1.5"
							:options="senderOptions"
							:model-value="selectedSenderId"
							placeholder="Choose a sender"
							:error="senderError ?? undefined"
							@update:model-value="onSelectSender"
						/>
						<p v-if="!isCustomSelected && !senderError" class="mt-1.5 text-sm text-text-tertiary">
							Recipients see this name and address. Manage the list in Settings → Campaign senders.
						</p>

						<!-- Custom address (only reachable when the instance allows custom senders) -->
						<div v-if="isCustomSelected" class="mt-4 space-y-4">
							<div>
								<label for="fromName" class="label flex items-center gap-2">
									<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
									From Name <span class="text-error">*</span>
								</label>
								<input
									id="fromName"
									v-model="form.fromName"
									type="text"
									placeholder="e.g., John from Acme Inc"
									:class="['input mt-1.5', senderErrorField === 'name' ? 'input-error' : '']"
								/>
								<p class="mt-1.5 text-sm text-text-tertiary">
									The name recipients will see when they receive your email.
								</p>
							</div>

							<div>
								<label for="fromEmail" class="label flex items-center gap-2">
									<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
									From Email <span class="text-error">*</span>
								</label>
								<input
									id="fromEmail"
									v-model="form.fromEmail"
									type="email"
									placeholder="e.g., hello@acme.com"
									:class="['input mt-1.5', senderErrorField === 'email' ? 'input-error' : '']"
								/>
								<p
									v-if="domainVerificationWarning"
									class="mt-1.5 text-sm text-warning flex items-center gap-1.5"
								>
									<Icon name="lucide:alert-circle" class="w-4 h-4 shrink-0" />
									{{ domainVerificationWarning }}
								</p>
								<p
									v-else-if="domainVerificationStatus?.verified"
									class="mt-1.5 text-sm text-success flex items-center gap-1.5"
								>
									<Icon name="lucide:check-circle" class="w-4 h-4 shrink-0" />
									Domain "{{ domainVerificationStatus.domain }}" is verified
								</p>
								<p v-else class="mt-1.5 text-sm text-text-tertiary">
									The email address your campaign will be sent from.
								</p>
							</div>
						</div>
					</template>
				</div>

				<div>
					<label for="replyTo" class="label flex items-center gap-2">
						<Icon name="lucide:reply" class="w-4 h-4 text-text-tertiary" />
						Reply-to Email <span class="text-text-tertiary">(optional)</span>
					</label>
					<input
						id="replyTo"
						v-model="form.replyTo"
						type="email"
						placeholder="e.g., support@acme.com"
						:class="['input mt-1.5', basicsValidation.hasError('replyTo') ? 'input-error' : '']"
					/>
					<p v-if="basicsValidation.getError('replyTo', true)" class="mt-1.5 text-sm text-error">
						{{ basicsValidation.getError('replyTo', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						Replies will be sent to this address. Leave empty to use the From Email.
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
				class="flex w-full items-center gap-2 text-left text-brand font-medium hover:opacity-80 transition-opacity"
				@click="addABTest"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add an A/B test
			</button>
			<p class="mt-1 text-sm text-text-tertiary">
				Optional — send two versions to part of your audience, then the winner to the rest.
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
				Remove A/B test
			</button>
		</div>

		<!-- Actions -->
		<div class="flex items-center justify-between pt-2">
			<UiButton variant="secondary" @click="emit('cancel')">Cancel</UiButton>
			<UiButton type="submit" :loading="isLoading" :disabled="!canSubmit">
				{{ isLoading ? 'Saving...' : 'Next' }}
				<template v-if="!isLoading" #iconRight>
					<Icon name="lucide:arrow-right" class="w-4 h-4" />
				</template>
			</UiButton>
		</div>
	</form>
</template>
