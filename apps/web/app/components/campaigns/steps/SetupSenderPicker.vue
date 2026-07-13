<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail } from '~/utils/validation';
import { senderAuthDisplay } from '~/utils/senderAlignment';
import {
	CUSTOM_SENDER_VALUE,
	buildSenderOptions,
	defaultSenderValue,
	isCustomSender,
	senderSelectionProblem,
} from '~/utils/campaignSenderPicker';

// Only the persisted-campaign fields the one-shot preselect reads.
interface CampaignSenderDetails {
	fromName?: string | null;
	fromEmail?: string | null;
}

const props = defineProps<{
	// Distinguishes "new campaign" from "editing" so the preselect waits for the
	// persisted campaign to load before choosing a row.
	campaignId: Id<'campaigns'> | null;
	// `undefined` while the campaign query is loading; `null` when there is none.
	campaignDetails: CampaignSenderDetails | null | undefined;
}>();

// The from name/address are the source of truth in the parent form (submit
// payload + review summary); a curated selection writes them here via v-model.
const fromName = defineModel<string>('fromName', { required: true });
const fromEmail = defineModel<string>('fromEmail', { required: true });

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

// The curated sender currently chosen (null on the custom branch or before a
// pick) and its live authenticity verdict — domain verification + whether the
// active transport signs/bounces this address in a DMARC-aligned way. Drives the
// chip AND the disable-with-reason send-gate below, from one source of truth.
const selectedCuratedSender = computed(() => {
	if (isCustomSelected.value || !selectedSenderId.value) return null;
	return senders.value.find((s) => s._id === selectedSenderId.value) ?? null;
});
const selectedSenderAuth = computed(() => {
	const sender = selectedCuratedSender.value;
	if (!sender) return null;
	return senderAuthDisplay({
		verified: sender.domainVerified,
		alignment: sender.alignment,
		reason: sender.alignmentReason,
	});
});

// No curated senders AND no custom escape hatch: nothing is selectable, so show
// an empty-state (admin deep link vs. "ask your admin") instead of a picker.
const showSenderEmptyState = computed(() => senders.value.length === 0 && !isCustomAllowed.value);

function onSelectSender(value: string | null) {
	selectedSenderId.value = value ?? '';
	senderError.value = null;
	senderErrorField.value = null;
}

// A curated selection is the source of truth for the from name/address; keep the
// form fields (read by the review summary) in sync. The custom branch leaves the
// fields for the user to edit.
watch(selectedSenderId, (value) => {
	if (value === CUSTOM_SENDER_VALUE || !value) return;
	const sender = senders.value.find((s) => s._id === value);
	if (sender) {
		fromName.value = sender.displayName ?? '';
		fromEmail.value = sender.email;
	}
});

// One-shot preselect once the picker (and, when editing, the persisted campaign)
// has loaded: reuse the campaign's saved sender if it still matches a curated
// row, fall back to the custom branch when allowed, else the default sender.
let senderInitialized = false;
watch(
	[senders, isCustomAllowed, () => props.campaignDetails],
	() => {
		if (senderInitialized || !senderPicker.value) return;
		if (props.campaignId && props.campaignDetails === undefined) return;
		senderInitialized = true;

		const existingEmail = props.campaignDetails?.fromEmail?.trim().toLowerCase();
		if (existingEmail) {
			const match = senders.value.find((s) => s.email === existingEmail);
			if (match) {
				selectedSenderId.value = match._id;
				return;
			}
			if (isCustomAllowed.value) {
				selectedSenderId.value = CUSTOM_SENDER_VALUE;
				fromName.value = props.campaignDetails?.fromName ?? '';
				fromEmail.value = props.campaignDetails?.fromEmail ?? '';
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
		const email = fromEmail.value.trim();
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

// One source of truth for the guard AND the messages: map the util's
// discriminated reason to human copy (the util already mirrors the server gate).
function validate(): string | null {
	senderError.value = null;
	senderErrorField.value = null;
	const problem = senderSelectionProblem(selectedSenderId.value, {
		fromName: fromName.value,
		fromEmail: fromEmail.value,
	});
	if (problem === 'none-selected') {
		senderError.value = 'Choose who this campaign sends from';
		return senderError.value;
	}
	if (problem === 'missing-name') {
		senderError.value = 'Enter a from name';
		senderErrorField.value = 'name';
		return senderError.value;
	}
	if (problem === 'invalid-email') {
		senderError.value = 'Enter a valid from address';
		senderErrorField.value = 'email';
		return senderError.value;
	}
	// A broken curated identity (unverified domain or a misaligned transport) can't
	// be sent from — surface the same reason the chip shows and block advancing.
	const auth = selectedSenderAuth.value;
	if (auth?.blocked) {
		senderError.value = auth.detail ?? 'This sender can’t be used right now.';
		return senderError.value;
	}
	return null;
}

const isReady = computed(
	() =>
		senderSelectionProblem(selectedSenderId.value, {
			fromName: fromName.value,
			fromEmail: fromEmail.value,
		}) === null && !selectedSenderAuth.value?.blocked
);

defineExpose({ validate, isReady });
</script>

<template>
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

			<!-- Live authenticity of the chosen curated sender: domain verification +
				     transport alignment. A broken identity is disabled-with-reason. -->
			<CampaignsSenderAuthChip
				v-if="selectedCuratedSender"
				class="mt-2"
				:verified="selectedCuratedSender.domainVerified"
				:alignment="selectedCuratedSender.alignment"
				:reason="selectedCuratedSender.alignmentReason"
			/>

			<!-- Custom address (only reachable when the instance allows custom senders) -->
			<div v-if="isCustomSelected" class="mt-4 space-y-4">
				<div>
					<label for="fromName" class="label flex items-center gap-2">
						<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
						From Name <span class="text-error">*</span>
					</label>
					<input
						id="fromName"
						v-model="fromName"
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
						v-model="fromEmail"
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
</template>
