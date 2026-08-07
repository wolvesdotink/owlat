<script setup lang="ts">
import { api } from '@owlat/api';
import { SEND_TRANSPORT_KINDS } from '@owlat/shared/sendProviderCatalog';
import { buildProviderEnvSkeleton } from '~/utils/deliveryEnvSnippet';
import { providerFeedbackPanel, providerFeedbackWebhookUrl } from '~/utils/providerFeedbackPanel';

useHead({ title: 'Delivery provider — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Admin-gated send-path status. Booleans only — the query never returns a
// credential value, just the presence of each required env var.
const {
	data: status,
	isLoading,
	error,
	refetch: refetchStatus,
} = useOrganizationQuery(api.delivery.status.getStatus);

const canSend = computed(() => status.value?.canSend === true);

// Provider feedback loop -----------------------------------------------------
// WHICH panel (if any) this transport's feedback channel needs, and where the
// provider posts — both are declarations on its catalog entry, resolved by
// `providerFeedbackPanel` (the seams plan's D2: capabilities, not identity). The
// page therefore names no provider: a sixth one gets the panel its declaration
// earns, and a kind whose channel needs nothing from the operator — our own MTA,
// which we wire ourselves — renders none, exactly as before.
const feedbackPanel = computed(() => providerFeedbackPanel(status.value?.provider));

const runtimeConfig = useRuntimeConfig();
// Absolute HTTPS endpoint the provider posts to: this deployment's site URL plus
// the path the entry declares. When the site URL is unknown it is '' (never a
// relative path — an SNS HTTPS subscription can't use one) so the copy block
// hides behind a "site URL not configured" hint instead of handing the operator
// a broken value. Mirrors the useFormSettings precedent.
const feedbackWebhookUrl = computed(() =>
	providerFeedbackWebhookUrl(
		status.value?.provider,
		runtimeConfig.public.convexSiteUrl || runtimeConfig.public.convexUrl
	)
);

// Live "last event received" — enabled only for the SNS panel so we don't poll
// otherwise.
//
// STILL A PER-KIND QUERY, exactly like the signed-webhook read below:
// `getLastSesEventAt` reads SES's own event table, while the gate above it is a
// MECHANISM (`setupPanel: 'sns-topic'`). That mismatch is not left to be noticed
// — `providerFeedbackPanel` holds each panel's answering set, so a second
// `sns-topic` kind gets NO panel rather than SES's timestamp under its name, and
// generalising the read is what opens the set. Still open, and owned by no plan
// piece: the feedback-adapter registry generalised the ROUTES, not this query.
const { data: lastSesEventAt } = useOrganizationQuery(api.delivery.status.getLastSesEventAt, () =>
	feedbackPanel.value === 'sns-topic' ? {} : undefined
);
const lastSesEventLabel = computed(() => {
	const at = lastSesEventAt.value;
	if (!at) return null;
	return new Date(at).toLocaleString();
});

// The signed-webhook panel's own read: because the SIGNING key is not part of
// what the transport needs to SEND, `getStatus.requiredEnv` cannot answer
// whether it is present.
//
// STILL A PER-KIND QUERY: the backend has one key-presence read per signed kind
// rather than one that answers for whichever kind is active. As above, the
// panel's answering set in `providerFeedbackPanel` is what keeps a second signed
// kind from being shown MANDRILL_WEBHOOK_KEY's presence as its own. Generalising
// the read is still open work, unowned by any plan piece — see the note on
// `PANEL_ANSWERS_FOR_KINDS`.
const { data: mandrillFeedback } = useOrganizationQuery(
	api.delivery.status.getMandrillFeedbackStatus,
	() => (feedbackPanel.value === 'signed-webhook' ? {} : undefined)
);

// Names of the required env vars the active provider is MISSING. Names only —
// `getStatus` never returns credential values, so nothing secret reaches here.
const missingEnvNames = computed(() =>
	(status.value?.requiredEnv ?? []).filter((entry) => !entry.isPresent).map((entry) => entry.name)
);

// Paste-ready `.env` skeleton for the missing vars (one `NAME=` line, empty
// values), in the order the ACTIVE KIND'S CATALOG ENTRY declares them. Empty
// string when nothing is missing → the snippet block hides.
const envSnippet = computed(() =>
	buildProviderEnvSkeleton(status.value?.provider, missingEnvNames.value)
);

// CLI command to set the first missing var, as a concrete example the operator
// can adapt. Falls back to the generic form when the list is empty.
const envSetCommand = computed(() => {
	const first = missingEnvNames.value[0];
	return first ? `owlat-setup env ${first} <value>` : 'owlat-setup env <KEY> <value>';
});

const { copy, isCopied } = useCopyToClipboard();

// Transport connection wizard (P2-4) — an OFFER, never a to-do item (plan D2).
// Both reads are DNS-facing and non-secret, and both are answered ENTIRELY on
// the server: which domain we sign as, and which transport is the REFERENCE arm,
// are facts about the `domains` table and the configured transport surface, not
// something this page can derive from the transport status. Passing no arguments
// is what keeps them right — an earlier revision derived the domain here and got
// an inert step 3, and derived the probe target from the ACTIVE provider, which
// on a standalone deployment is our own MTA.
//
// Both are total: no verified signing domain answers `null`, and no relay
// answers `transportId: null` with the unresolvable posture. Neither is an
// error, and neither renders one.
//
// Both are passed through UNCHANGED, `undefined` included: `undefined` is the
// read in flight and `null` is a resolved negative answer, and collapsing the
// two renders a finding about a question that has not been answered yet.
const { data: alignmentArms } = useOrganizationQuery(
	api.delivery.alignmentPreflight.getAlignmentArms
);
const { data: returnPathReadiness } = useOrganizationQuery(
	api.delivery.relayReturnPath.getReturnPathReadiness
);

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
			<!-- Plan D8: exactly one reference relay, or the ramp has no single
			     second arm to judge the own server against and every cell holds.
			     Renders nothing in every healthy configuration, standalone included. -->
			<DeliveryReferenceRelayNotice />

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
									>{{ envSnippet }}</pre
								>
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
									>{{ envSetCommand }}</pre
								>
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

			<!-- Optional guided "connect an ESP" flow: credentials → live send test
			     → live-DNS alignment → return-path capability. Skipping it leaves the
			     deployment fully functional on its own MTA (plan D2), so it renders as
			     a plain offer with no warning state of any kind. -->
			<DeliveryTransportConnectionWizard
				:alignment-arms="alignmentArms"
				:return-path-transport-id="returnPathReadiness?.transportId"
				:return-path-capability="returnPathReadiness?.capability"
				:can-send="canSend"
				@applied="refetchStatus"
			/>

			<!-- Inbound TLS hardening: publish our own MTA-STS policy (none →
			     testing → enforce). Receiving posture, but it lives beside the
			     transport controls so all TLS policy is in one place. -->
			<DeliveryMtaStsModeCard />

			<!-- Inbound sender authenticity: which forwarders we trust to rescue a
			     DMARC fail on mailing-list / forwarded mail (Sealed Mail A5). -->
			<DeliveryTrustedForwardersCard />

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
					<!-- The kinds this build carries, from the catalog: a provider added
					     there is offered here without an edit (plan D1). -->
					<p v-else class="text-sm text-text-tertiary border-t border-border-subtle pt-5">
						Select a delivery provider (set <code class="text-text-primary">EMAIL_PROVIDER</code> to
						<template v-for="(kind, index) in SEND_TRANSPORT_KINDS" :key="kind"
							><span v-if="index > 0">{{
								index === SEND_TRANSPORT_KINDS.length - 1 ? ', or ' : ', '
							}}</span
							><code class="text-text-primary">{{ kind }}</code></template
						>) to see its required variables.
					</p>
				</div>
			</UiCard>

			<!-- Send test email -->
			<DeliveryTestSendCard
				:can-send="canSend"
				:last-test-succeeded-at="status?.lastTestSucceededAt"
			/>

			<!-- Signed-webhook feedback (a provider that posts events with a key) -->
			<DeliveryMandrillWebhookCard
				v-if="feedbackPanel === 'signed-webhook'"
				:webhook-url="feedbackWebhookUrl"
				:is-webhook-key-present="mandrillFeedback?.isWebhookKeyPresent === true"
				:last-event-at="mandrillFeedback?.lastEventAt ?? null"
			/>

			<!-- SNS-topic feedback (bounces & complaints delivered through a topic) -->
			<UiCard v-if="feedbackPanel === 'sns-topic'" padding="none" overflow="hidden">
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
					<div v-if="feedbackWebhookUrl">
						<div class="flex items-center justify-between mb-2">
							<p class="text-xs font-medium text-text-primary">SNS subscription endpoint</p>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
								:title="isCopied('ses-url') ? 'Copied' : 'Copy endpoint URL'"
								@click="copy(feedbackWebhookUrl, 'ses-url')"
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
							>{{ feedbackWebhookUrl }}</pre
						>
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
