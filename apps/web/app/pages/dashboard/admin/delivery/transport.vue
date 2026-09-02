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
	layout: 'admin',
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

		<!--
			One state machine for the whole page: loading → error → "no status
			yet" → content. The three branches used to be hand-rolled `v-if`s
			whose loading arm was a bare centred spinner and whose content arm
			had no `v-else` at all, so a `getStatus` that resolved to nothing
			rendered this header and then a blank page.
		-->
		<UiQueryBoundary
			:loading="isLoading && !status"
			:error="error"
			:empty="!status"
			:error-title="t('dashboard.admin.delivery.transport.error.title')"
			:error-message="t('dashboard.admin.delivery.transport.error.message')"
			@retry="refetchStatus"
		>
			<!--
				Content-shaped placeholder at the geometry the status and
				configuration cards occupy, so nothing reflows when the query
				lands. Same idiom as the sibling delivery list pages, which
				stand in for their rows with DashboardListSkeleton.
			-->
			<template #loading>
				<div
					class="space-y-6 max-w-3xl"
					role="status"
					aria-busy="true"
					:aria-label="t('dashboard.admin.delivery.transport.loadingLabel')"
				>
					<UiCard padding="none" overflow="hidden">
						<div class="p-6 flex items-start gap-4">
							<UiSkeleton class="w-12 h-12 rounded-xl shrink-0" />
							<div class="flex-1 min-w-0 space-y-2.5">
								<UiSkeleton class="h-5 w-48" />
								<UiSkeletonText :lines="2" size="sm" last-line-width="w-1/2" />
							</div>
						</div>
					</UiCard>
					<UiCard v-for="card in 2" :key="card" padding="none" overflow="hidden">
						<div class="p-6 space-y-4">
							<UiSkeleton class="h-4 w-40" />
							<UiSkeleton v-for="row in 3" :key="row" class="h-10 rounded-lg" />
						</div>
					</UiCard>
				</div>
			</template>

			<!--
				Resolved, and the answer is "nothing configured" — an honest
				terminal state rather than a blank page or a card full of
				zeroes. Mirrors the deliverability page's own no-setup state.
			-->
			<template #empty>
				<UiEmptyState
					icon="lucide:server-off"
					:eyebrow="t('dashboard.admin.delivery.transport.title')"
					:title="t('dashboard.admin.delivery.transport.empty.title')"
					:description="t('dashboard.admin.delivery.transport.empty.description')"
				>
					<template #action>
						<UiButton to="/dashboard/admin/delivery">
							{{ t('dashboard.admin.delivery.transport.empty.action') }}
						</UiButton>
					</template>
				</UiEmptyState>
			</template>

			<div v-if="status" class="space-y-6 max-w-3xl">
				<!-- Plan D8: exactly one reference relay, or the ramp has no single
				     second arm to judge the own server against and every cell holds.
				     Renders nothing in every healthy configuration, standalone included. -->
				<DeliveryReferenceRelayNotice />

				<!-- Can-send status -->
				<DeliveryTransportCanSendCard
					:can-send="canSend"
					:env-snippet="envSnippet"
					:env-set-command="envSetCommand"
				/>

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
						<div v-if="status.requiredEnv?.length" class="border-t border-border-subtle pt-5">
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
										<Icon
											:name="entry.isPresent ? 'lucide:check' : 'lucide:x'"
											class="w-3.5 h-3.5"
										/>
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
		</UiQueryBoundary>
	</div>
</template>
