<script setup lang="ts">
import { api } from '@owlat/api';
import { SEND_TRANSPORT_KINDS } from '@owlat/shared/sendProviderCatalog';
import { buildProviderEnvSkeleton } from '~/utils/deliveryEnvSnippet';
import {
	providerFeedbackPanel,
	providerFeedbackSigningKeyEnvVar,
	providerFeedbackWebhookUrl,
} from '~/utils/providerFeedbackPanel';
import { transportKindLabel } from '~/utils/transportState';

const { t } = useI18n();

/**
 * `utils/transportState` is a module-scope definition set whose kind labels carry
 * i18n keys rather than sentences (the registry convention); a plain string is
 * still accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

useHead({ title: () => t('dashboard.admin.delivery.transport.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
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

// The two vendor facts the signed-webhook panel prints — the provider's NAME and
// the NAME of the variable its signing key goes in — both read off the ACTIVE
// kind's catalog entry. The card is the CEREMONY's, not one vendor's: it used to
// spell the first provider's variable for every kind declaring the ceremony, so
// the second one's operator set a variable the backend does not read and watched
// a "missing" chip (fed by the backend's own list) that could never clear.
const feedbackProviderLabel = computed(() =>
	localized(transportKindLabel(status.value?.provider ?? ''))
);
const feedbackSigningKeyEnvVar = computed(
	() => providerFeedbackSigningKeyEnvVar(status.value?.provider) ?? ''
);

// One provider-bundle status read serves every feedback ceremony. The query is
// keyed by transport id and returns presence-only configuration facts plus the
// newest retained event timestamp; it never exposes a verifier secret or body.
const { data: feedbackStatus } = useOrganizationQuery(
	api.delivery.status.getProviderFeedbackStatus,
	() =>
		feedbackPanel.value && status.value?.provider
			? { transportId: status.value.provider }
			: undefined
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
				to="/dashboard/admin/delivery"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.delivery.backToSetup') }}
			</NuxtLink>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:send" size="lg" variant="brand" rounded="xl" />
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.delivery.transport.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.admin.delivery.transport.lede') }}
					</p>
				</div>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading" class="flex items-center justify-center py-16">
			<Icon name="lucide:loader-2" class="w-8 h-8 animate-spin motion-reduce:animate-none text-text-tertiary" />
		</div>

		<UiErrorAlert
			v-else-if="error"
			:title="t('dashboard.admin.delivery.transport.error.title')"
			:message="t('dashboard.admin.delivery.transport.error.message')"
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
							{{
								canSend
									? t('dashboard.admin.delivery.transport.canSend.yes')
									: t('dashboard.admin.delivery.transport.canSend.no')
							}}
						</h2>
						<p class="text-sm text-text-secondary mt-1">
							<template v-if="canSend">
								{{ t('dashboard.admin.delivery.transport.canSend.yesBody') }}
							</template>
							<I18nT
								v-else
								keypath="dashboard.admin.delivery.transport.canSend.noBody"
								scope="global"
							>
								<template #envVar><code class="text-text-primary">EMAIL_PROVIDER</code></template>
							</I18nT>
						</p>

						<!-- Actionable remedy: paste-ready .env skeleton + CLI command for the
						     MISSING vars. Names only — no secret value is ever rendered. -->
						<div v-if="!canSend && envSnippet" class="mt-4 space-y-4">
							<!-- .env skeleton -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<I18nT
										keypath="dashboard.admin.delivery.transport.env.addToEnv"
										tag="p"
										class="text-xs font-medium text-text-primary"
										scope="global"
									>
										<template #file><code class="text-text-primary">.env</code></template>
									</I18nT>
									<UiButton
										variant="ghost"
										size="sm"
										:title="
											isCopied('env-snippet')
												? t('common.copied')
												: t('dashboard.admin.delivery.transport.env.copySnippet')
										"
										@click="copy(envSnippet, 'env-snippet')"
									>
										<Icon
											:name="isCopied('env-snippet') ? 'lucide:check' : 'lucide:copy'"
											class="w-3.5 h-3.5"
											:class="isCopied('env-snippet') ? 'text-success' : ''"
										/>
										{{ isCopied('env-snippet') ? t('common.copied') : t('common.copy') }}
									</UiButton>
								</div>
								<pre
									class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
									>{{ envSnippet }}</pre>
								<p class="text-xs text-text-tertiary mt-1.5">
									{{ t('dashboard.admin.delivery.transport.env.blankValues') }}
								</p>
							</div>

							<!-- CLI command -->
							<div>
								<div class="flex items-center justify-between mb-2">
									<p class="text-xs font-medium text-text-primary">
										{{ t('dashboard.admin.delivery.transport.env.cliTitle') }}
									</p>
									<UiButton
										variant="ghost"
										size="sm"
										:title="
											isCopied('env-cmd')
												? t('common.copied')
												: t('dashboard.admin.delivery.transport.env.copyCommand')
										"
										@click="copy(envSetCommand, 'env-cmd')"
									>
										<Icon
											:name="isCopied('env-cmd') ? 'lucide:check' : 'lucide:copy'"
											class="w-3.5 h-3.5"
											:class="isCopied('env-cmd') ? 'text-success' : ''"
										/>
										{{ isCopied('env-cmd') ? t('common.copied') : t('common.copy') }}
									</UiButton>
								</div>
								<pre
									class="select-all overflow-x-auto rounded-lg bg-bg-surface px-3 py-2 font-mono text-xs text-text-primary"
									>{{ envSetCommand }}</pre>
								<I18nT
									keypath="dashboard.admin.delivery.transport.env.cliHint"
									tag="p"
									class="text-xs text-text-tertiary mt-1.5"
									scope="global"
								>
									<template #command>
										<code class="text-text-primary">owlat-setup env --show</code>
									</template>
									<template #guideLink>
										<a
											href="https://docs.owlat.app/developer/environment-variables"
											target="_blank"
											rel="noopener"
											class="text-brand hover:text-brand-hover underline"
											>{{ t('dashboard.admin.delivery.transport.env.guideLink') }}</a
										>
									</template>
								</I18nT>
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
							<h2 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.delivery.transport.config.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.delivery.transport.config.subtitle') }}
							</p>
						</div>
					</div>
				</template>

				<div class="p-6 space-y-5">
					<!-- Active provider -->
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium text-text-primary">
								{{ t('dashboard.admin.delivery.transport.config.activeProvider') }}
							</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{ t('dashboard.admin.delivery.transport.config.activeProviderHint') }}
							</p>
						</div>
						<UiBadge v-if="status.provider && status.isKnownProvider" variant="default" size="md">
							{{ status.provider }}
						</UiBadge>
						<UiBadge v-else variant="error" size="md">
							{{
								status.provider
									? t('dashboard.admin.delivery.transport.config.unknownProvider', {
											provider: status.provider,
										})
									: t('dashboard.admin.delivery.transport.config.notSet')
							}}
						</UiBadge>
					</div>

					<!-- Required env presence (booleans only — never the secret value) -->
					<div v-if="status.requiredEnv.length > 0" class="border-t border-border-subtle pt-5">
						<p class="text-sm font-medium text-text-primary mb-3">
							{{ t('dashboard.admin.delivery.transport.config.requiredEnv') }}
						</p>
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
									{{
										entry.isPresent
											? t('dashboard.admin.delivery.transport.config.present')
											: t('dashboard.admin.delivery.transport.config.missing')
									}}
								</span>
							</li>
						</ul>
						<p class="text-xs text-text-tertiary mt-3">
							{{ t('dashboard.admin.delivery.transport.config.presenceOnly') }}
						</p>
					</div>
					<!-- The kinds this build carries, from the catalog: a provider added
					     there is offered here without an edit (plan D1). -->
					<I18nT
						v-else
						keypath="dashboard.admin.delivery.transport.config.selectProvider"
						tag="p"
						class="text-sm text-text-tertiary border-t border-border-subtle pt-5"
						scope="global"
					>
						<template #envVar><code class="text-text-primary">EMAIL_PROVIDER</code></template>
						<template #kinds>
							<template v-for="(kind, index) in SEND_TRANSPORT_KINDS" :key="kind"
								><span v-if="index > 0">{{
									index === SEND_TRANSPORT_KINDS.length - 1
										? t('dashboard.admin.delivery.transport.config.listLastSeparator')
										: t('dashboard.admin.delivery.transport.config.listSeparator')
								}}</span
								><code class="text-text-primary">{{ kind }}</code></template
							>
						</template>
					</I18nT>
				</div>
			</UiCard>

			<!-- Send test email -->
			<DeliveryTestSendCard
				:can-send="canSend"
				:last-test-succeeded-at="status?.lastTestSucceededAt"
			/>

			<!-- Signed-webhook feedback (a provider that posts events with a key) -->
			<DeliverySignedWebhookCard
				v-if="feedbackPanel === 'signed-webhook'"
				:provider-kind="status?.provider ?? ''"
				:provider-label="feedbackProviderLabel"
				:signing-key-env-var="feedbackSigningKeyEnvVar"
				:webhook-url="feedbackWebhookUrl"
				:is-webhook-key-present="feedbackStatus?.missingVariables.length === 0"
				:last-event-at="feedbackStatus?.lastEventAt ?? null"
			/>

			<!-- SNS-topic feedback (bounces & complaints delivered through a topic) -->
			<DeliverySnsTopicCard
				v-if="feedbackPanel === 'sns-topic'"
				:webhook-url="feedbackWebhookUrl"
				:last-event-at="feedbackStatus?.lastEventAt ?? null"
			/>

			<!-- Inbound TLS reports (TLS-RPT, RFC 8460) partners send us -->
			<DeliveryTlsReportCard
				:summary="tlsReportSummary"
				:is-loading="tlsReportLoading"
				:error="tlsReportError"
			/>
		</div>
	</div>
</template>
