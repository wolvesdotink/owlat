<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { hasInboundFeature } from '~/utils/inboundDns';
import { computeSpfSuggestion, type SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import { useDomainAutoRecheck } from '~/composables/useDomainAutoRecheck';
import type { DmarcPolicy } from '~/utils/domainStatus';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.delivery.domains.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading, role } = useOrganizationContext();

// Get domains with real-time updates
const { data: domainsData, isLoading: domainsLoading } = useOrganizationQuery(
	api.domains.domains.listByOrganization
);
const { data: sendingOverview } = useOrganizationQuery(
	api.analytics.reputationQueries.getSendingOverview
);
const outboundIpDetail = computed(() => {
	const overview = sendingOverview.value;
	return overview?.warming ? { warming: overview.warming, volume: overview.volume } : null;
});

const isLoading = computed(() => teamLoading.value || domainsLoading.value);

// Offer the external-mailbox path (connect your own IMAP/SMTP) when no domain
// is verified and the feature is enabled — the "no domain to send from" wall.
const { isEnabled, flags, isLoading: flagsLoading } = useFeatureFlag();
const hasVerifiedDomain = computed(() =>
	(domainsData.value ?? []).some((d) => d.status === 'verified')
);

// Mutations
const { run: createDomain } = useBackendOperation(api.domains.domains.create, {
	label: () => t('dashboard.admin.delivery.domains.operations.add'),
});
const { run: removeDomain } = useBackendOperation(api.domains.domains.remove, {
	label: () => t('dashboard.admin.delivery.domains.operations.remove'),
});
const { run: retryRegistration } = useBackendOperation(api.domains.domains.regenerateDnsRecords, {
	label: () => t('dashboard.admin.delivery.domains.operations.retryRegistration'),
});
const { run: setDmarcPolicy } = useBackendOperation(api.domains.domains.setDmarcPolicy, {
	label: () => t('dashboard.admin.delivery.domains.operations.updateDmarc'),
});
const { run: verifyDomain } = useBackendOperation(api.domains.dnsVerification.verifyDomain, {
	label: () => t('dashboard.admin.delivery.domains.operations.verify'),
	type: 'action',
});
// Dev-only mutation: the import + binding gets tree-shaken from prod bundles
// because the only references live behind `import.meta.env.DEV`, which Vite
// replaces with a literal `false` during `nuxt build`. Backend additionally
// refuses unless `OWLAT_DEV_MODE` is enabled — see
// apps/api/convex/devShortcuts/_guard.ts.
const isDevBuild = import.meta.env.DEV;
const { run: forceVerifyDomain } = isDevBuild
	? useBackendOperation(api.devShortcuts.forceVerifyDomain.forceVerifyDomain, {
			label: () => t('dashboard.admin.delivery.domains.operations.forceVerify'),
		})
	: { run: async (_: { domainId: Id<'domains'> }) => ({ ok: false }) as const };

// Force Verify is owner/admin-only. The backend re-checks via
// `requirePermission('organization:manage')`; the client-side gate is here so
// editors don't see a button that 403s on click.
const canForceVerify = computed(
	() => isDevBuild && (role.value === 'owner' || role.value === 'admin')
);

const forcingDomainId = ref<Id<'domains'> | null>(null);

// Toast notifications
const { showToast } = useToast();

// Add domain modal. The form body lives in DomainsAddDomainForm, which owns its
// own field state and re-initializes each time the modal opens (UiModal v-if's
// its slot), so there is nothing to reset here.
const addModal = useModal();

// Delete confirmation modal
const deleteModal = useConfirmModal<{ _id: Id<'domains'>; domain: string }>();

// Verification state
const verifyingDomainId = ref<Id<'domains'> | null>(null);

// Expanded domain (showing DNS records)
const expandedDomainId = ref<Id<'domains'> | null>(null);

// Deep link from the Delivery health page's "Fix →": `?domain=<name>` opens
// that domain's setup panel straight away and scrolls it into view, so the user
// lands on the exact record they came to fix rather than a generic list. Runs
// once the (real-time) domain list resolves, then clears the query so a manual
// collapse isn't fought by the watcher.
const route = useRoute();
const router = useRouter();
watch(
	() => [route.query['domain'], domainsData.value] as const,
	([queryDomain]) => {
		if (typeof queryDomain !== 'string' || !queryDomain) return;
		const match = (domainsData.value ?? []).find((d) => d.domain === queryDomain);
		if (!match) return;
		expandedDomainId.value = match._id;
		const { domain: _handled, ...rest } = route.query;
		void router.replace({ query: rest });
		void nextTick(() => {
			const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			document
				.getElementById(`domain-${match._id}`)
				?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
		});
	},
	{ immediate: true }
);

// Add-domain orchestration (register with an optional custom return-path host,
// set atomically in one write) lives in a plain, directly-testable flow composable.
const { handleAddDomain } = useAddDomain({
	hasActiveOrganization: () => hasActiveOrganization.value,
	createDomain,
	setLoading: (loading) => addModal.setLoading(loading),
	close: () => addModal.close(),
	showToast,
});

// Handle delete domain
const handleDeleteDomain = async () => {
	if (!deleteModal.data.value) return;

	deleteModal.setLoading(true);
	const result = await removeDomain({ domainId: deleteModal.data.value._id });
	deleteModal.setLoading(false);

	if (!result.ok) return;

	deleteModal.close();
	showToast(t('dashboard.admin.delivery.domains.toasts.removed'));
};

// Handle verify domain — routed through useBackendOperation (shared error
// vocabulary + telemetry); verifyingDomainId drives the per-row spinner.
const handleVerifyDomain = async (domainId: Id<'domains'>) => {
	verifyingDomainId.value = domainId;
	try {
		const result = await verifyDomain({ domainId });
		if (!result.ok) return; // run() already surfaced the failure
		if (result.result.allVerified) {
			showToast(t('dashboard.admin.delivery.domains.toasts.verified'));
		} else {
			showToast(t('dashboard.admin.delivery.domains.toasts.verificationIncomplete'), 'error');
		}
	} finally {
		verifyingDomainId.value = null;
	}
};

// Handle retry registration (for failed registration)
const handleRetryRegistration = async (domainId: Id<'domains'>) => {
	const result = await retryRegistration({ domainId });
	if (!result.ok) return;
	showToast(t('dashboard.admin.delivery.domains.toasts.regenerating'));
};

// DMARC enforcement policy. Owners/admins only (backend gates on
// `organization:manage`); editors see the generated record read-only.
const canManageDomains = computed(() => role.value === 'owner' || role.value === 'admin');

// Inbound/receiving DNS guidance. `getInboundMailConfig` is admin-gated
// (organization:manage), so skip the subscription for non-admins (the read
// would 403, and the Receiving panel is an operator task anyway). Returns the
// deployment's mail host (MX target) plus the inbound SMTP port.
const { data: inboundMailConfig } = useConvexQuery(api.domains.domains.getInboundMailConfig, () =>
	canManageDomains.value ? {} : 'skip'
);
// Show the Receiving (MX) section whenever the deployment has a mail host to
// point at — regardless of whether an inbound feature is on yet. Gating it on
// the flag hid the MX instructions from the very admin trying to enable inbound
// (chicken-and-egg); instead it renders always and shows an honest "not turned
// on yet — here's how" state when `inboundEnabled` is false.
//
// Hold the section until the feature-flag subscription has resolved: the app is
// `ssr: false`, so `flags` starts all-off and `inboundEnabled` would compute
// false during the loading window, flashing a dishonest "not turned on yet"
// banner on an inbound-enabled install. Waiting on `flagsLoading` keeps it true.
const inboundEnabled = computed(() => hasInboundFeature(flags.value));
const showReceivingDns = computed(
	() => Boolean(inboundMailConfig.value?.mailHost) && !flagsLoading.value
);
const dmarcPolicyOptions = computed<{ value: DmarcPolicy; label: string; hint: string }[]>(() => [
	{
		value: 'none',
		label: t('dashboard.admin.delivery.domains.dmarc.none.label'),
		hint: t('dashboard.admin.delivery.domains.dmarc.none.hint'),
	},
	{
		value: 'quarantine',
		label: t('dashboard.admin.delivery.domains.dmarc.quarantine.label'),
		hint: t('dashboard.admin.delivery.domains.dmarc.quarantine.hint'),
	},
	{
		value: 'reject',
		label: t('dashboard.admin.delivery.domains.dmarc.reject.label'),
		hint: t('dashboard.admin.delivery.domains.dmarc.reject.hint'),
	},
]);
const updatingDmarcDomainId = ref<Id<'domains'> | null>(null);

const handleDmarcPolicyChange = async (domainId: Id<'domains'>, policy: DmarcPolicy) => {
	updatingDmarcDomainId.value = domainId;
	try {
		const result = await setDmarcPolicy({ domainId, policy });
		if (!result.ok) return; // run() already surfaced the failure
		showToast(
			policy === 'none'
				? t('dashboard.admin.delivery.domains.toasts.dmarcMonitorOnly')
				: t('dashboard.admin.delivery.domains.toasts.dmarcRaised', { policy })
		);
	} finally {
		updatingDmarcDomainId.value = null;
	}
};

// Dev-only: skip DNS verification entirely. Refused server-side on prod
// deployments (assertDevDeployment in apps/api/convex/devShortcuts/_guard.ts).
const handleForceVerify = async (domainId: Id<'domains'>) => {
	forcingDomainId.value = domainId;
	const result = await forceVerifyDomain({ domainId });
	forcingDomainId.value = null;
	if (!result.ok) return;
	showToast(t('dashboard.admin.delivery.domains.toasts.forceVerified'));
};

// SPF coexistence hint for the currently-expanded domain. When a domain that
// isn't verified yet already publishes a foreign SPF record, we proactively
// resolve it (DoH) and suggest a single merged record rather than a second
// v=spf1 (which would be a PermError, RFC 7208 §3.2).
const spfCoexistence = ref<SpfCoexistenceSuggestion | null>(null);

// Toggle domain expansion
const toggleDomainExpansion = (domainId: Id<'domains'>) => {
	const expanding = expandedDomainId.value !== domainId;
	expandedDomainId.value = expanding ? domainId : null;
	// The hint belongs to whichever panel is open — drop it on any change, then
	// recompute only when an unverified domain with an SPF record is expanded.
	spfCoexistence.value = null;
	if (!expanding) return;
	const domain = (domainsData.value ?? []).find((d) => d._id === domainId);
	const spfValue = domain?.dnsRecords?.spf?.value;
	if (!domain || domain.status === 'verified' || !spfValue) return;
	void computeSpfSuggestion(domain.domain, spfValue).then((result) => {
		// Ignore a slow DoH response if the user has since collapsed or switched.
		if (expandedDomainId.value === domainId) spfCoexistence.value = result;
	});
};

// Gentle auto-recheck while a domain panel is open: the polling lifecycle (which
// domain, the mirrored "Checking DNS…" flag, teardown) lives in its own
// composable, over the framework-agnostic poller in `utils/domainAutoRecheck`.
const { autoRecheckActive } = useDomainAutoRecheck({
	expandedDomainId,
	domains: () => domainsData.value ?? [],
	isVerifying: (domainId) => verifyingDomainId.value === domainId,
	verifyDomain,
});
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
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.admin.delivery.domains.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.admin.delivery.domains.lede') }}
					</p>
				</div>
				<UiButton class="gap-2" @click="addModal.open()">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.delivery.domains.addDomain') }}
				</UiButton>
			</div>
		</div>

		<!-- First-load skeleton (shaped like the domain list) -->
		<div v-if="isLoading && !domainsData" class="card overflow-hidden">
			<DashboardListSkeleton variant="card" leading :rows="4" />
		</div>

		<!-- No Team State -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:globe" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.delivery.domains.noTeam.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.delivery.domains.noTeam.description') }}
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:globe" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">
							{{ t('dashboard.admin.delivery.domains.whyCustom.title') }}
						</h3>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.admin.delivery.domains.whyCustom.body') }}
						</p>
					</div>
				</div>
			</div>

			<!-- Per-transport DNS guidance: what to check depends on how this
				 instance sends (managed MTA records vs a relay that signs on your
				 behalf). Demoted below the "why add a domain" card so the first thing
				 under the h1 builds the mental model, not transports. The exact records
				 each configured relay wants follow it. -->
			<DeliveryDomainDnsGuidance />
			<DeliveryRelayDomainStatus />

			<!-- Outbound IP identity is DNS setup too: keep quarantine reasons and
			     exact PTR repair guidance on the day-one domains surface. -->
			<DeliverySendingDetails
				v-if="outboundIpDetail"
				:warming="outboundIpDetail.warming"
				:volume="outboundIpDetail.volume"
			/>

			<!-- No verified domain → offer connecting an external mailbox instead -->
			<div
				v-if="isEnabled('mail.external') && !hasVerifiedDomain"
				class="card p-6 bg-bg-surface flex items-start gap-4"
			>
				<UiIconBox icon="lucide:mail-plus" size="sm" variant="surface" rounded="lg" />
				<div class="flex-1">
					<h3 class="font-medium text-text-primary mb-1">
						{{ t('dashboard.admin.delivery.domains.noDomain.title') }}
					</h3>
					<p class="text-sm text-text-secondary mb-3">
						{{ t('dashboard.admin.delivery.domains.noDomain.body') }}
					</p>
					<UiButton variant="secondary" size="sm" to="/dashboard/postbox/migrate" class="gap-2">
						<Icon name="lucide:mail-plus" class="w-4 h-4" />
						{{ t('dashboard.admin.delivery.domains.noDomain.action') }}
					</UiButton>
				</div>
			</div>

			<!-- Empty State -->
			<div
				v-if="domainsData && domainsData.length === 0"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:globe" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">
					{{ t('dashboard.admin.delivery.domains.empty.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					{{ t('dashboard.admin.delivery.domains.empty.description') }}
				</p>
				<UiButton class="gap-2 mt-4" @click="addModal.open()">
					<Icon name="lucide:plus" class="w-4 h-4" />
					{{ t('dashboard.admin.delivery.domains.empty.action') }}
				</UiButton>
			</div>

			<!-- Domains List -->
			<div v-else-if="domainsData && domainsData.length > 0" class="space-y-4">
				<DomainsRecordRow
					v-for="domain in domainsData"
					:id="`domain-${domain._id}`"
					:key="domain._id"
					:domain="domain"
					:is-expanded="expandedDomainId === domain._id"
					:can-force-verify="canForceVerify"
					:can-manage-domains="canManageDomains"
					:is-forcing="forcingDomainId === domain._id"
					:is-verifying="verifyingDomainId === domain._id"
					:is-updating-dmarc="updatingDmarcDomainId === domain._id"
					:auto-recheck-active="autoRecheckActive"
					:spf-coexistence="spfCoexistence"
					:dmarc-policy-options="dmarcPolicyOptions"
					:show-receiving-dns="showReceivingDns"
					:inbound-mail-host="inboundMailConfig?.mailHost ?? null"
					:inbound-port="inboundMailConfig?.inboundPort ?? 25"
					:inbound-enabled="inboundEnabled"
					@toggle="toggleDomainExpansion(domain._id)"
					@force-verify="handleForceVerify(domain._id)"
					@verify="handleVerifyDomain(domain._id)"
					@retry-registration="handleRetryRegistration(domain._id)"
					@delete="deleteModal.open(domain)"
					@dmarc-change="(policy) => handleDmarcPolicyChange(domain._id, policy)"
				/>
			</div>

			<!-- Tracking Domains (branded open/click tracking) -->
			<div class="pt-2 border-t border-border-subtle">
				<DomainsTrackingDomainsSection />
			</div>
		</div>

		<!-- Add Domain Modal — the guided two-field picker lives in the form
			 component, which composes the single domain string it emits. -->
		<UiModal
			v-model:open="addModal.isOpen.value"
			:title="t('dashboard.admin.delivery.domains.addModalTitle')"
		>
			<DomainsAddDomainForm
				:loading="addModal.isLoading.value"
				@submit="handleAddDomain"
				@cancel="addModal.close()"
			/>
		</UiModal>

		<!-- Delete Domain Confirmation Modal -->
		<UiConfirmationDialog
			v-model:open="deleteModal.isOpen.value"
			:title="t('dashboard.admin.delivery.domains.removeModal.title')"
			:description="
				t('dashboard.admin.delivery.domains.removeModal.description', {
					domain: deleteModal.data.value?.domain ?? '',
				})
			"
			:confirm-text="t('dashboard.admin.delivery.domains.removeModal.confirm')"
			variant="danger"
			:is-loading="deleteModal.isLoading.value"
			@confirm="handleDeleteDomain"
		/>
	</div>
</template>
