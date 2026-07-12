<script setup lang="ts">
import { api } from '@owlat/api';
import { isValidEmail } from '~/utils/validation';
import { buildDeliveryEnvSnippet } from '~/utils/deliveryEnvSnippet';

useHead({ title: 'Delivery provider — Owlat' });

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
	refetch: refetchStatus,
} = useOrganizationQuery(api.delivery.status.getStatus);

const canSend = computed(() => status.value?.canSend === true);

// SES feedback loop --------------------------------------------------------
// Only relevant when SES is the active provider. The webhook URL and the live
// "last event received" line let an admin wire up and confirm the SNS topic.
const isSes = computed(() => status.value?.provider === 'ses');

const runtimeConfig = useRuntimeConfig();
// Absolute HTTPS endpoint SNS subscribes to. When the site URL is unknown we
// return '' (never a relative path — an SNS HTTPS subscription can't use one)
// so the copy block hides behind a "site URL not configured" hint instead of
// handing the operator a broken value. Mirrors the useFormSettings precedent.
const sesWebhookUrl = computed(() => {
	const base = runtimeConfig.public.convexSiteUrl || runtimeConfig.public.convexUrl;
	return base ? `${base.replace(/\/$/, '')}/webhooks/ses` : '';
});

// Live "last event received" — enabled only for SES so we don't poll otherwise.
const { data: lastSesEventAt } = useOrganizationQuery(api.delivery.status.getLastSesEventAt, () =>
	isSes.value ? {} : undefined
);
const lastSesEventLabel = computed(() => {
	const at = lastSesEventAt.value;
	if (!at) return null;
	return new Date(at).toLocaleString();
});

// Names of the required env vars the active provider is MISSING. Names only —
// `getStatus` never returns credential values, so nothing secret reaches here.
const missingEnvNames = computed(() =>
	(status.value?.requiredEnv ?? []).filter((entry) => !entry.isPresent).map((entry) => entry.name)
);

// Paste-ready `.env` skeleton for the missing vars (one `NAME=` line, empty
// values). Empty string when nothing is missing → the snippet block hides.
const envSnippet = computed(() => buildDeliveryEnvSnippet(missingEnvNames.value));

// CLI command to set the first missing var, as a concrete example the operator
// can adapt. Falls back to the generic form when the list is empty.
const envSetCommand = computed(() => {
	const first = missingEnvNames.value[0];
	return first ? `owlat-setup env ${first} <value>` : 'owlat-setup env <KEY> <value>';
});

const { copy, isCopied } = useCopyToClipboard();

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
	{ immediate: true }
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

// Inbound TLS-RPT (RFC 8460) roll-up — daily reports partners send us about
// TLS negotiation when delivering mail to our MX. Member-safe (operator
// deliverability telemetry, no credentials).
const {
	data: tlsReportSummary,
	isLoading: tlsReportLoading,
	error: tlsReportError,
} = useOrganizationQuery(api.domains.tlsReports.getTlsReportSummary);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/delivery/setup"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Delivery setup
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:send" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Delivery provider</h1>
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
				<div class="p-6 flex items-start gap-4" :class="canSend ? 'bg-success/5' : 'bg-error/5'">
					<div
						class="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center"
						:class="canSend ? 'bg-success/15 text-success' : 'bg-error/15 text-error'"
					>
						<Icon
							:name="canSend ? 'lucide:check-circle-2' : 'lucide:alert-triangle'"
							class="w-6 h-6"
						/>
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

						<!-- Actionable remedy: paste-ready .env skeleton + CLI command for the
						     MISSING vars. Names only — no secret value is ever rendered. -->
						<div v-if="!canSend && envSnippet" class="mt-4 space-y-4">
							<!-- .env skeleton -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<p class="text-xs font-medium text-text-primary">
										Add to your <code class="text-text-primary">.env</code>, then restart the
										instance
									</p>
									<button
										type="button"
										class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:title="isCopied('env-snippet') ? 'Copied' : 'Copy .env snippet'"
										@click="copy(envSnippet, 'env-snippet')"
									>
										<Icon
											:name="isCopied('env-snippet') ? 'lucide:check' : 'lucide:copy'"
											class="w-3.5 h-3.5"
											:class="isCopied('env-snippet') ? 'text-success' : ''"
										/>
										{{ isCopied('env-snippet') ? 'Copied' : 'Copy' }}
									</button>
								</div>
								<pre
									class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
									>{{ envSnippet }}</pre>
								<p class="text-xs text-text-tertiary mt-1.5">
									Values are left blank — fill in your real credentials. They are never displayed
									here.
								</p>
							</div>

							<!-- CLI command -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<p class="text-xs font-medium text-text-primary">Or set each one from the CLI</p>
									<button
										type="button"
										class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
										:title="isCopied('env-cmd') ? 'Copied' : 'Copy command'"
										@click="copy(envSetCommand, 'env-cmd')"
									>
										<Icon
											:name="isCopied('env-cmd') ? 'lucide:check' : 'lucide:copy'"
											class="w-3.5 h-3.5"
											:class="isCopied('env-cmd') ? 'text-success' : ''"
										/>
										{{ isCopied('env-cmd') ? 'Copied' : 'Copy' }}
									</button>
								</div>
								<pre
									class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
									>{{ envSetCommand }}</pre>
								<p class="text-xs text-text-tertiary mt-1.5">
									Run <code class="text-text-primary">owlat-setup env --show</code> to list every
									variable your current configuration needs. See the
									<a
										href="https://docs.owlat.app/developer/environment-variables"
										target="_blank"
										rel="noopener"
										class="text-brand hover:text-brand-hover underline"
										>environment variables guide</a
									>.
								</p>
							</div>
						</div>
					</div>
				</div>
			</UiCard>

			<!-- Editable transport editor — change provider / rotate credentials in
			     place, tested and applied through the same env-patch the setup wizard
			     uses. The status cards above stay the read-only at-a-glance summary. -->
			<DeliveryTransportEditor
				:current-provider="status.provider"
				:current-outbound-tls-mode="status.outboundTlsMode"
				@applied="refetchStatus"
			/>

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
							<p class="text-xs text-text-tertiary mt-0.5">
								From the EMAIL_PROVIDER environment variable
							</p>
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
									<Icon :name="entry.isPresent ? 'lucide:check' : 'lucide:x'" class="w-3.5 h-3.5" />
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
						<code class="text-text-primary">mta</code>,
						<code class="text-text-primary">resend</code>, or
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
						<UiButton
							:loading="isSending"
							:disabled="isSending || !canSend"
							@click="handleSendTest"
						>
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

			<!-- SES bounce & complaint feedback (only when SES is the provider) -->
			<UiCard v-if="isSes" padding="none" overflow="hidden">
				<template #header>
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:radio" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">
								SES bounce &amp; complaint feedback
							</h2>
							<p class="text-sm text-text-secondary">
								Let SES tell Owlat when mail bounces or is marked as spam, so those addresses are
								suppressed automatically
							</p>
						</div>
					</div>
				</template>

				<div class="p-6 space-y-5">
					<p class="text-sm text-text-secondary">
						SES delivers this feedback through an Amazon SNS topic. Point an HTTPS subscription at
						the endpoint below — Owlat verifies each message&rsquo;s signature and confirms the
						subscription for you.
					</p>

					<!-- Webhook endpoint -->
					<div v-if="sesWebhookUrl">
						<div class="flex items-center justify-between mb-2">
							<p class="text-xs font-medium text-text-primary">SNS subscription endpoint</p>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								:title="isCopied('ses-url') ? 'Copied' : 'Copy endpoint URL'"
								@click="copy(sesWebhookUrl, 'ses-url')"
							>
								<Icon
									:name="isCopied('ses-url') ? 'lucide:check' : 'lucide:copy'"
									class="w-3.5 h-3.5"
									:class="isCopied('ses-url') ? 'text-success' : ''"
								/>
								{{ isCopied('ses-url') ? 'Copied' : 'Copy' }}
							</button>
						</div>
						<pre
							class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
							>{{ sesWebhookUrl }}</pre>
					</div>
					<p v-else class="text-xs text-text-tertiary">
						Set your site URL to see the endpoint SNS should subscribe to.
					</p>

					<!-- Setup steps -->
					<ol class="space-y-2 text-sm text-text-secondary list-decimal pl-5">
						<li>
							In the SNS console, create a topic (e.g.
							<code class="text-text-primary">owlat-ses-feedback</code>) and add an
							<span class="text-text-primary">HTTPS</span> subscription with the endpoint above.
						</li>
						<li>
							Set <code class="text-text-primary">SES_SNS_TOPIC_ARN</code> to that topic&rsquo;s
							ARN. Owlat only accepts feedback from this exact topic, so the endpoint stays closed
							until it&rsquo;s set.
						</li>
						<li>
							In the SES console, create a
							<span class="text-text-primary">Configuration Set</span> with an event destination
							publishing <code class="text-text-primary">Bounce</code>,
							<code class="text-text-primary">Complaint</code> and
							<code class="text-text-primary">Delivery</code> events to that topic.
						</li>
						<li>
							Set <code class="text-text-primary">SES_CONFIGURATION_SET</code> to the set&rsquo;s
							name so every send is attributed. Changes take effect on the next send — no restart
							needed.
						</li>
					</ol>

					<!-- Live "last event received" line -->
					<div class="flex items-center gap-2 text-xs">
						<template v-if="lastSesEventLabel">
							<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5 text-success" />
							<span class="text-success">Last event received: {{ lastSesEventLabel }}</span>
						</template>
						<template v-else>
							<Icon name="lucide:clock" class="w-3.5 h-3.5 text-text-tertiary" />
							<span class="text-text-tertiary">
								No feedback received yet. Once the subscription is confirmed and a message bounces
								or is delivered, it appears here.
							</span>
						</template>
					</div>
				</div>
			</UiCard>

			<!-- Inbound TLS reports (TLS-RPT, RFC 8460) partners send us -->
			<DeliveryTlsReportCard
				:summary="tlsReportSummary"
				:is-loading="tlsReportLoading"
				:error="tlsReportError"
			/>
		</div>
	</div>
</template>
