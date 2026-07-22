<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail } from '~/utils/validation';

interface Props {
	open: boolean;
	html: string;
	subject: string;
	templateId?: Id<'emailTemplates'> | null;
	variables?: Array<{ key: string; label?: string }>;
	dataVariableSchema?: Array<{ key: string; type: string }>;
}

const props = withDefaults(defineProps<Props>(), {
	variables: () => [],
	dataVariableSchema: () => [],
});

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

const { showToast } = useToast();
const convex = useConvex();

// Form state
const testEmails = ref<string[]>(['']);
const sampleData = ref<Record<string, string>>({
	firstName: 'Test',
	lastName: 'User',
	email: '',
});
const dataVariableValues = ref<Record<string, string>>({});

// Sending state
const isSending = ref(false);
const sendResult = ref<{ success: boolean; message: string } | null>(null);

// Instance settings for from email
const { data: orgSettings } = useOrganizationQuery(api.workspaces.settings.get);

// Verified domains for the organization
const { data: domains } = useOrganizationQuery(api.domains.domains.listByOrganization);

// Computed: from email options
const fromEmail = computed(() => {
	// Use organization default if available
	if (orgSettings.value?.defaultFromEmail) {
		return orgSettings.value.defaultFromEmail;
	}
	// Fall back to first verified domain
	const verifiedDomain = domains.value?.find((d) => d.status === 'verified');
	if (verifiedDomain) {
		return `noreply@${verifiedDomain.domain}`;
	}
	return '';
});

const fromName = computed(() => orgSettings.value?.defaultFromName || '');

// Computed: check if we can send (have a verified domain)
const canSend = computed(() => {
	const hasVerifiedDomain = domains.value?.some((d) => d.status === 'verified');
	const hasValidEmails = testEmails.value.some((e) => isValidEmail(e));
	return hasVerifiedDomain && hasValidEmails && fromEmail.value;
});

const noVerifiedDomain = computed(() => !domains.value?.some((d) => d.status === 'verified'));

// Add email field
const addEmailField = () => {
	if (testEmails.value.length < 5) {
		testEmails.value.push('');
	}
};

// Remove email field
const removeEmailField = (index: number) => {
	if (testEmails.value.length > 1) {
		testEmails.value.splice(index, 1);
	}
};

// Handle send
const handleSend = async () => {
	if (!canSend.value || isSending.value || !convex) return;

	const validEmails = testEmails.value.filter((e) => isValidEmail(e)).map((e) => e.trim());
	if (validEmails.length === 0) {
		showToast('Please enter at least one valid email address', 'error');
		return;
	}

	isSending.value = true;
	sendResult.value = null;

	try {
		// Use the first test email as the sample email if not set
		const finalSampleData = {
			...sampleData.value,
			email: sampleData.value['email'] || validEmails[0],
		};

		// Collect non-empty data variable values
		const nonEmptyDataVars: Record<string, string> = {};
		for (const [key, val] of Object.entries(dataVariableValues.value)) {
			if (val) nonEmptyDataVars[key] = val;
		}

		const result = await convex.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
			templateId: props.templateId || undefined,
			htmlContent: props.html,
			subject: props.subject,
			testEmails: validEmails,
			fromEmail: fromEmail.value,
			fromName: fromName.value || undefined,
			sampleData: finalSampleData,
			dataVariables: Object.keys(nonEmptyDataVars).length > 0 ? nonEmptyDataVars : undefined,
		});

		sendResult.value = {
			success: true,
			message: result.message,
		};

		showToast(result.message, 'success');

		// Close modal after short delay on success
		setTimeout(() => {
			close();
		}, 1500);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to queue test email';
		sendResult.value = {
			success: false,
			message,
		};
		showToast(message, 'error');
	} finally {
		isSending.value = false;
	}
};

// Close modal
const close = () => {
	emit('update:open', false);
	// Reset state after animation
	setTimeout(() => {
		sendResult.value = null;
	}, 300);
};

// Reset form when modal opens
watch(
	() => props.open,
	(isOpen) => {
		if (isOpen) {
			testEmails.value = [''];
			sampleData.value = {
				firstName: 'Test',
				lastName: 'User',
				email: '',
			};
			// Initialize data variable values with empty strings
			const vars: Record<string, string> = {};
			for (const v of props.dataVariableSchema) {
				vars[v.key] = '';
			}
			dataVariableValues.value = vars;
			sendResult.value = null;
		}
	}
);
</script>

<template>
	<UiModal
		:open="open"
		size="lg"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:send" size="sm" variant="brand" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Queue Test Email</h2>
				<p class="text-sm text-text-secondary">Preview how your email will look</p>
			</div>
		</div>

		<!-- Content -->
		<div class="space-y-6">
			<!-- No verified domain warning -->
			<div v-if="noVerifiedDomain" class="flex items-start gap-3 p-4 bg-warning-subtle rounded-lg">
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
				<div>
					<p class="font-medium text-warning">No verified domain</p>
					<p class="text-sm text-text-secondary mt-1">
						You need to verify a domain before sending test emails. Go to Settings &gt; Domains to
						add and verify your domain.
					</p>
				</div>
			</div>

			<!-- From info -->
			<div v-if="fromEmail" class="flex items-center gap-3 p-3 bg-bg-surface rounded-lg">
				<Icon name="lucide:mail" class="w-4 h-4 text-text-tertiary" />
				<div class="text-sm">
					<span class="text-text-secondary">From: </span>
					<span class="text-text-primary">
						{{ fromName ? `${fromName} <${fromEmail}>` : fromEmail }}
					</span>
				</div>
			</div>

			<!-- Test emails -->
			<div class="space-y-3">
				<label class="block text-sm font-medium text-text-primary">
					Send to (max 5 addresses)
				</label>
				<div class="space-y-2">
					<div v-for="(_, index) in testEmails" :key="index" class="flex items-center gap-2">
						<div class="relative flex-1">
							<input
								v-model="testEmails[index]"
								type="email"
								placeholder="email@example.com"
								class="w-full pl-10 pr-4 py-2.5 bg-bg-surface border border-border-default rounded-lg text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20"
								:class="{
									'border-error': testEmails[index] && !isValidEmail(testEmails[index]),
								}"
							/>
							<Icon
								name="lucide:mail"
								class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
							/>
						</div>
						<button
							v-if="testEmails.length > 1"
							class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
							@click="removeEmailField(index)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				</div>
				<button
					v-if="testEmails.length < 5"
					class="flex items-center gap-2 text-sm text-brand hover:text-brand-hover transition-colors"
					@click="addEmailField"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
					Add another email
				</button>
			</div>

			<!-- Sample data for personalization -->
			<div v-if="variables.length > 0" class="space-y-3">
				<label class="block text-sm font-medium text-text-primary">
					Sample data for variables
				</label>
				<p class="text-xs text-text-secondary">
					These values will replace <span v-pre>{{...}}</span> variables in the preview
				</p>
				<div class="grid grid-cols-2 gap-3">
					<div class="relative">
						<input
							v-model="sampleData['firstName']"
							type="text"
							placeholder="First Name"
							class="w-full pl-10 pr-4 py-2 bg-bg-surface border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20"
						/>
						<Icon
							name="lucide:user"
							class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
						/>
					</div>
					<div>
						<input
							v-model="sampleData['lastName']"
							type="text"
							placeholder="Last Name"
							class="w-full px-4 py-2 bg-bg-surface border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20"
						/>
					</div>
				</div>
			</div>

			<!-- Custom data variables -->
			<div v-if="dataVariableSchema.length > 0" class="space-y-3">
				<label class="block text-sm font-medium text-text-primary"> Data variables </label>
				<p class="text-xs text-text-secondary">
					Fill in sample values for your custom data variables
				</p>
				<div class="grid grid-cols-2 gap-3">
					<div v-for="variable in dataVariableSchema" :key="variable.key" class="relative">
						<input
							v-model="dataVariableValues[variable.key]"
							type="text"
							:placeholder="variable.key"
							class="w-full pl-10 pr-4 py-2 bg-bg-surface border border-border-default rounded-lg text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand/20"
						/>
						<Icon
							name="lucide:variable"
							class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
						/>
					</div>
				</div>
			</div>

			<!-- Result message -->
			<Transition name="fade">
				<div
					v-if="sendResult"
					class="flex items-center gap-3 p-4 rounded-lg"
					:class="sendResult.success ? 'bg-success-subtle' : 'bg-error-subtle'"
				>
					<Icon
						v-if="sendResult.success"
						name="lucide:check-circle"
						class="w-5 h-5 text-success flex-shrink-0"
					/>
					<Icon v-else name="lucide:alert-circle" class="w-5 h-5 text-error flex-shrink-0" />
					<p class="text-sm" :class="sendResult.success ? 'text-success' : 'text-error'">
						{{ sendResult.message }}
					</p>
				</div>
			</Transition>
		</div>

		<template #footer>
			<button
				class="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
				@click="close"
			>
				Cancel
			</button>
			<button
				class="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand text-text-inverse rounded-lg hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				:disabled="!canSend || isSending"
				@click="handleSend"
			>
				<UiSpinner v-if="isSending" size="xs" tone="inverse" />
				<Icon v-else name="lucide:send" class="w-4 h-4" />
				<span>{{ isSending ? 'Queueing...' : 'Queue Test' }}</span>
			</button>
		</template>
	</UiModal>
</template>

<style scoped>
/* Fade transition for result */
.fade-enter-active,
.fade-leave-active {
	transition: opacity var(--motion-moderate) var(--ease-spring);
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
