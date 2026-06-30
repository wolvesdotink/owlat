<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { rules } from '~/composables/useFormValidation';
import { isValidEmail } from '~/utils/validation';

interface Props {
	campaignId: Id<'campaigns'> | null;
	initialData?: {
		campaignName: string;
		fromName: string;
		fromEmail: string;
		replyTo: string;
	};
}

const props = withDefaults(defineProps<Props>(), {
	initialData: () => ({
		campaignName: '',
		fromName: '',
		fromEmail: '',
		replyTo: '',
	}),
});

const emit = defineEmits<{
	submit: [campaignId: Id<'campaigns'>];
	cancel: [];
}>();

// Form state
const form = reactive({
	campaignName: props.initialData.campaignName,
	fromName: props.initialData.fromName,
	fromEmail: props.initialData.fromEmail,
	replyTo: props.initialData.replyTo,
});

// Watch for prop changes
watch(
	() => props.initialData,
	(newData) => {
		if (newData) {
			form.campaignName = newData.campaignName;
			form.fromName = newData.fromName;
			form.fromEmail = newData.fromEmail;
			form.replyTo = newData.replyTo;
		}
	}
);

// Validation
const validation = useFormValidation({
	campaignName: [rules.required('Campaign name is required')],
	fromName: [rules.required('From name is required')],
	fromEmail: [
		rules.required('From email is required'),
		rules.email('Please enter a valid email address'),
	],
	replyTo: [rules.email('Please enter a valid email address')],
});

// Mutations
const { run: createCampaign } = useBackendOperation(api.campaigns.campaigns.create, {
	label: 'Create campaign',
});
const { run: updateBasics } = useBackendOperation(api.campaigns.campaigns.updateBasics, {
	label: 'Update campaign basics',
});

// Modal state — only the loading flag is needed; validation surfaces via
// `useFormValidation` and backend errors are surfaced by the operation module.
const { isLoading, setLoading } = useModal();

// Domain verification status
const { data: domainVerificationStatus } = useOrganizationQuery(
	api.domains.domains.getEmailDomainVerificationStatus,
	() => {
		const email = form.fromEmail.trim();
		if (!email || !isValidEmail(email)) return undefined;
		return { email };
	}
);

const domainVerificationWarning = computed(() => {
	if (!domainVerificationStatus.value) return null;
	const status = domainVerificationStatus.value;

	if (!status.exists) {
		return {
			type: 'warning' as const,
			message: `Domain "${status.domain}" is not registered. You can continue editing, but sending is disabled until you add and verify this domain in Settings > Domains.`,
		};
	}

	if (!status.verified) {
		return {
			type: 'warning' as const,
			message: `Domain "${status.domain}" is not verified. You can continue editing, but sending is disabled until DNS verification completes in Settings > Domains.`,
		};
	}

	if (status.stale) {
		return {
			type: 'warning' as const,
			message: `Domain verification is stale (last checked ${status.lastVerifiedAt ? new Date(status.lastVerifiedAt).toLocaleDateString() : 'never'}). Consider re-verifying.`,
		};
	}

	return null;
});

// Custom validation that includes domain check
const validate = (): boolean => {
	return validation.validate(form);
};

const handleSubmit = async () => {
	if (!validate()) return;

	setLoading(true);
	try {
		let campaignId = props.campaignId;

		// Create campaign if not exists
		if (!campaignId) {
			const newCampaignId = await createCampaign({
				name: form.campaignName.trim(),
			});
			if (!newCampaignId) return;
			campaignId = newCampaignId;
		}

		// Update basics
		const result = await updateBasics({
			campaignId: campaignId,
			name: form.campaignName.trim(),
			fromName: form.fromName.trim(),
			fromEmail: form.fromEmail.trim(),
			replyTo: form.replyTo.trim() || undefined,
		});
		if (result === undefined) return;

		emit('submit', campaignId!);
	} finally {
		setLoading(false);
	}
};

// Expose form data for parent
defineExpose({
	form,
});
</script>

<template>
	<div class="card p-6">
		<div class="mb-6">
			<h2 class="text-xl font-semibold text-text-primary">Campaign Details</h2>
			<p class="text-text-secondary mt-1">Enter the basic information for your campaign.</p>
		</div>

		<form @submit.prevent="handleSubmit">
			<div class="space-y-6">
				<!-- Campaign Name -->
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
						:class="['input mt-1.5', validation.hasError('campaignName') ? 'input-error' : '']"
					/>
					<p v-if="validation.getError('campaignName', true)" class="mt-1.5 text-sm text-error">
						{{ validation.getError('campaignName', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						This name is for your reference and won't be visible to recipients.
					</p>
				</div>

				<!-- From Name -->
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
						:class="['input mt-1.5', validation.hasError('fromName') ? 'input-error' : '']"
					/>
					<p v-if="validation.getError('fromName', true)" class="mt-1.5 text-sm text-error">
						{{ validation.getError('fromName', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						The name recipients will see when they receive your email.
					</p>
				</div>

				<!-- From Email -->
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
						:class="['input mt-1.5', validation.hasError('fromEmail') ? 'input-error' : '']"
					/>
					<p v-if="validation.getError('fromEmail', true)" class="mt-1.5 text-sm text-error">
						{{ validation.getError('fromEmail', true) }}
					</p>
					<p
						v-else-if="domainVerificationWarning?.type === 'warning'"
						class="mt-1.5 text-sm text-warning flex items-center gap-1.5"
					>
						<Icon name="lucide:alert-circle" class="w-4 h-4 shrink-0" />
						{{ domainVerificationWarning.message }}
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

				<!-- Reply-to Email -->
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
						:class="['input mt-1.5', validation.hasError('replyTo') ? 'input-error' : '']"
					/>
					<p v-if="validation.getError('replyTo', true)" class="mt-1.5 text-sm text-error">
						{{ validation.getError('replyTo', true) }}
					</p>
					<p v-else class="mt-1.5 text-sm text-text-tertiary">
						Replies will be sent to this address. Leave empty to use the From Email.
					</p>
				</div>
			</div>

			<!-- Actions -->
			<div class="flex items-center justify-between mt-8 pt-6 border-t border-border-subtle">
				<UiButton variant="secondary" @click="emit('cancel')">Cancel</UiButton>
				<UiButton type="submit" :loading="isLoading" :disabled="isLoading">
					{{ isLoading ? 'Saving...' : 'Next' }}
					<template v-if="!isLoading" #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4" /></template>
				</UiButton>
			</div>
		</form>
	</div>
</template>
