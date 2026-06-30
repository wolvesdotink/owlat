<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';

useHead({ title: 'Delivery — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { user } = useAuth();
const { showToast } = useToast();

// Admin-gated send-path status. Booleans only — the query never returns a
// credential value, just the presence of each required env var.
const {
	data: status,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.status.getStatus);

const canSend = computed(() => status.value?.canSend === true);

const lastTestLabel = computed(() => {
	const at = status.value?.lastTestSucceededAt;
	if (!at) return null;
	return new Date(at).toLocaleString();
});

// Test send -----------------------------------------------------------------
const testEmail = ref('');
const testError = ref('');
watch(
	user,
	(u) => {
		if (u?.email && !testEmail.value) testEmail.value = u.email;
	},
	{ immediate: true },
);

const { run: sendTest, isLoading: isSending } = useBackendOperation(api.delivery.status.sendTest, {
	label: 'Send test email',
	type: 'action',
});

async function handleSendTest() {
	testError.value = '';
	const to = testEmail.value.trim();
	if (!isValidEmail(to)) {
		testError.value = 'Enter a valid recipient email address.';
		return;
	}
	const result = await sendTest({ to });
	if (result === undefined) return; // backend operation already surfaced the error
	if (result.success) {
		showToast(`Test email sent to ${to}`);
	} else {
		testError.value = result.error ?? 'Test send failed.';
	}
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings/technical"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Technical
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:send" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Delivery</h1>
					<p class="mt-1 text-text-secondary">
						Configure and validate the email delivery provider this instance sends through
					</p>
				</div>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin text-text-tertiary" />
		</div>

		<UiErrorAlert
			v-else-if="error"
			title="Couldn't load delivery status"
			message="Delivery configuration is only visible to owners and admins. If you are an admin, reload to try again."
			class="my-8"
		/>

		<div v-else-if="status" class="space-y-6 max-w-3xl">
			<!-- Can-send status -->
			<UiCard padding="none" overflow="hidden">
				<div
					class="p-6 flex items-start gap-4"
					:class="canSend ? 'bg-success/5' : 'bg-error/5'"
				>
					<div
						class="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
						:class="canSend ? 'bg-success/15 text-success' : 'bg-error/15 text-error'"
					>
						<Icon :name="canSend ? 'lucide:check-circle-2' : 'lucide:alert-triangle'" class="w-6 h-6" />
					</div>
					<div class="flex-1 min-w-0">
						<h2 class="text-lg font-semibold" :class="canSend ? 'text-success' : 'text-error'">
							{{ canSend ? 'This instance can send email' : 'This instance cannot send email' }}
						</h2>
						<p class="text-sm text-text-secondary mt-1">
							<template v-if="canSend">
								A delivery provider is configured and its credentials are present. Send a test email
								below to confirm the full path end-to-end.
							</template>
							<template v-else>
								No usable delivery provider is configured. Until one is, campaigns and transactional
								sends will fail. Set <code class="text-text-primary">EMAIL_PROVIDER</code> and its
								credentials in your environment.
							</template>
						</p>
					</div>
				</div>
			</UiCard>

			<!-- Provider + required env presence -->
			<UiCard padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:server" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Provider configuration</h2>
							<p class="text-sm text-text-secondary">
								The active provider and the runtime variables it requires
							</p>
						</div>
					</div>
				</template>

				<div class="p-6 space-y-5">
					<!-- Active provider -->
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium text-text-primary">Active provider</p>
							<p class="text-xs text-text-tertiary mt-0.5">From the EMAIL_PROVIDER environment variable</p>
						</div>
						<UiBadge v-if="status.provider && status.isKnownProvider" variant="default" size="md">
							{{ status.provider }}
						</UiBadge>
						<UiBadge v-else variant="error" size="md">
							{{ status.provider ? `unknown: ${status.provider}` : 'not set' }}
						</UiBadge>
					</div>

					<!-- Required env presence (booleans only — never the secret value) -->
					<div v-if="status.requiredEnv.length > 0" class="border-t border-border-subtle pt-5">
						<p class="text-sm font-medium text-text-primary mb-3">Required environment variables</p>
						<ul class="space-y-2">
							<li
								v-for="entry in status.requiredEnv"
								:key="entry.name"
								class="flex items-center justify-between rounded-lg bg-bg-surface px-3 py-2"
							>
								<code class="text-sm text-text-primary">{{ entry.name }}</code>
								<span
									class="inline-flex items-center gap-1.5 text-xs font-medium"
									:class="entry.isPresent ? 'text-success' : 'text-error'"
								>
									<Icon
										:name="entry.isPresent ? 'lucide:check' : 'lucide:x'"
										class="w-3.5 h-3.5"
									/>
									{{ entry.isPresent ? 'present' : 'missing' }}
								</span>
							</li>
						</ul>
						<p class="text-xs text-text-tertiary mt-3">
							Only the presence of each variable is shown — secret values never leave the backend.
						</p>
					</div>
					<p v-else class="text-sm text-text-tertiary border-t border-border-subtle pt-5">
						Select a delivery provider (set <code class="text-text-primary">EMAIL_PROVIDER</code> to
						<code class="text-text-primary">mta</code>, <code class="text-text-primary">resend</code>, or
						<code class="text-text-primary">ses</code>) to see its required variables.
					</p>
				</div>
			</UiCard>

			<!-- Send test email -->
			<UiCard padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:mail-check" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">Send a test email</h2>
							<p class="text-sm text-text-secondary">
								Fire a real message through the configured provider to confirm delivery works
							</p>
						</div>
					</div>
				</template>

				<div class="p-6 space-y-4">
					<div class="flex flex-col sm:flex-row sm:items-end gap-3 max-w-xl">
						<div class="flex-1">
							<UiInput
								v-model="testEmail"
								type="email"
								label="Recipient"
								placeholder="you@example.com"
								:error="testError"
								:disabled="isSending"
							/>
						</div>
						<UiButton :loading="isSending" :disabled="isSending || !canSend" @click="handleSendTest">
							<template #iconLeft>
								<Icon v-if="!isSending" name="lucide:send" class="w-4 h-4" />
							</template>
							{{ isSending ? 'Sending…' : 'Send test email' }}
						</UiButton>
					</div>

					<p v-if="!canSend" class="text-xs text-warning flex items-center gap-1.5">
						<Icon name="lucide:alert-circle" class="w-3.5 h-3.5" />
						Configure a delivery provider before sending a test.
					</p>
					<p v-else-if="lastTestLabel" class="text-xs text-success flex items-center gap-1.5">
						<Icon name="lucide:check" class="w-3.5 h-3.5" />
						Last successful test: {{ lastTestLabel }}
					</p>
				</div>
			</UiCard>
		</div>
	</div>
</template>
