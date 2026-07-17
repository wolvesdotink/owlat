<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { hasInboundFeature } from '~/utils/inboundDns';
import { computeSpfSuggestion, type SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import { createAutoRecheckPoller, type AutoRecheckPoller } from '~/utils/domainAutoRecheck';
import type { DmarcPolicy } from '~/utils/domainStatus';

useHead({ title: 'Sending Domains — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading, role } = useOrganizationContext();

// Get domains with real-time updates
const { data: domainsData, isLoading: domainsLoading } = useOrganizationQuery(
	api.domains.domains.listByOrganization
);

const isLoading = computed(() => teamLoading.value || domainsLoading.value);

// Offer the external-mailbox path (connect your own IMAP/SMTP) when no domain
// is verified and the feature is enabled — the "no domain to send from" wall.
const { isEnabled, flags, isLoading: flagsLoading } = useFeatureFlag();
const hasVerifiedDomain = computed(() =>
	(domainsData.value ?? []).some((d) => d.status === 'verified')
);

// Mutations
const { run: createDomain } = useBackendOperation(api.domains.domains.create, {
	label: 'Add domain',
});
const { run: setReturnPathHost } = useBackendOperation(api.domains.returnPath.setReturnPathHost, {
	label: 'Set return-path host',
});
const { run: removeDomain } = useBackendOperation(api.domains.domains.remove, {
	label: 'Remove domain',
});
const { run: retryRegistration } = useBackendOperation(api.domains.domains.regenerateDnsRecords, {
	label: 'Retry domain registration',
});
const { run: setDmarcPolicy } = useBackendOperation(api.domains.domains.setDmarcPolicy, {
	label: 'Update DMARC policy',
});
const { run: verifyDomain } = useBackendOperation(api.domains.dnsVerification.verifyDomain, {
	label: 'Verify domain',
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
			label: 'Force-verify domain',
		})
	: { run: async (_: { domainId: Id<'domains'> }) => undefined };

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

// Handle add domain. The form composes + validates the value; this handler
// registers it, then sets a custom return-path host if one was supplied —
// `create` can't take the host (it needs the new id), so the page orchestrates
// both D-piece writes. A return-path failure is surfaced by the operation layer
// and the domain is still editable from its row, so we don't roll back create.
const handleAddDomain = async (payload: { domain: string; returnPathHost: string | null }) => {
	if (!hasActiveOrganization.value) return;

	addModal.setLoading(true);
	const domainId = await createDomain({ domain: payload.domain });
	if (domainId === undefined) {
		addModal.setLoading(false);
		return;
	}
	if (payload.returnPathHost) {
		await setReturnPathHost({ domainId, returnPathHost: payload.returnPathHost });
	}
	addModal.setLoading(false);

	addModal.close();
	showToast('Domain added successfully. Configure your DNS records to verify.');
};

// Handle delete domain
const handleDeleteDomain = async () => {
	if (!deleteModal.data.value) return;

	deleteModal.setLoading(true);
	const result = await removeDomain({ domainId: deleteModal.data.value._id });
	deleteModal.setLoading(false);

	if (result === undefined) return;

	deleteModal.close();
	showToast('Domain removed successfully');
};

// Handle verify domain — routed through useBackendOperation (shared error
// vocabulary + telemetry); verifyingDomainId drives the per-row spinner.
const handleVerifyDomain = async (domainId: Id<'domains'>) => {
	verifyingDomainId.value = domainId;
	try {
		const result = await verifyDomain({ domainId });
		if (result === undefined) return; // run() already surfaced the failure
		if (result.allVerified) {
			showToast('Domain verified successfully! All DNS records are correctly configured.');
		} else {
			showToast(
				'Verification complete. Some DNS records need attention - check the details below.',
				'error'
			);
		}
	} finally {
		verifyingDomainId.value = null;
	}
};

// Handle retry registration (for failed registration)
const handleRetryRegistration = async (domainId: Id<'domains'>) => {
	const result = await retryRegistration({ domainId });
	if (result === undefined) return;
	showToast('Regenerating DNS records...');
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
const dmarcPolicyOptions: { value: DmarcPolicy; label: string; hint: string }[] = [
	{
		value: 'none',
		label: 'Monitor only (p=none)',
		hint: 'Collect reports, take no action on failures.',
	},
	{ value: 'quarantine', label: 'Quarantine (p=quarantine)', hint: 'Send failing mail to spam.' },
	{
		value: 'reject',
		label: 'Reject (p=reject)',
		hint: 'Reject failing mail outright — full enforcement.',
	},
];
const updatingDmarcDomainId = ref<Id<'domains'> | null>(null);

const handleDmarcPolicyChange = async (domainId: Id<'domains'>, policy: DmarcPolicy) => {
	updatingDmarcDomainId.value = domainId;
	try {
		const result = await setDmarcPolicy({ domainId, policy });
		if (result === undefined) return; // run() already surfaced the failure
		showToast(
			policy === 'none'
				? 'DMARC set to monitor-only. Re-publish the updated _dmarc record, then verify.'
				: `DMARC policy raised to ${policy}. Re-publish the updated _dmarc record, then verify.`
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
	if (result === undefined) return;
	showToast('Domain force-verified (dev shortcut).');
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

// Gentle auto-recheck: once a domain panel is expanded, keep quietly re-running
// verifyDomain on a slow interval so the user doesn't have to click Verify over
// and over while DNS propagates. Only runs for domains that can still become
// verified — never for already-verified, still-registering, or
// failed-registration domains. Stops on verify, collapse, unmount, or the cap.
const autoRecheckActive = ref(false);

type AutoRecheckStatus = { status: string; lastRegistrationError?: string | null };
const isAutoRecheckable = (domain: AutoRecheckStatus | undefined): boolean => {
	if (!domain) return false;
	if (domain.status === 'verified' || domain.status === 'registering') return false;
	// A failed *registration* is not something re-running DNS verification fixes.
	if (domain.status === 'failed' && domain.lastRegistrationError) return false;
	return true;
};

let recheckPoller: AutoRecheckPoller | null = null;
let recheckDomainId: Id<'domains'> | null = null;

const stopAutoRecheck = () => {
	recheckPoller?.stop();
	recheckPoller = null;
	recheckDomainId = null;
	autoRecheckActive.value = false;
};

const startAutoRecheck = (domainId: Id<'domains'>) => {
	// Already polling this exact domain — leave the existing poller running. A
	// poller that has self-stopped (verified / cap reached) reports isRunning()
	// false, so it is not mistaken for a live one and auto-recheck can restart.
	if (recheckPoller && recheckDomainId === domainId && recheckPoller.isRunning()) return;
	stopAutoRecheck();
	recheckDomainId = domainId;
	autoRecheckActive.value = true;
	recheckPoller = createAutoRecheckPoller({
		onTick: async () => {
			// Never overlap with a manual Verify the user just clicked.
			if (verifyingDomainId.value === domainId) return false;
			const result = await verifyDomain({ domainId });
			// run() already surfaced any failure; treat undefined as "keep trying".
			return result?.allVerified === true;
		},
		onStopped: () => {
			// The poller stopped itself (domain verified, or the ~5-min cap was
			// reached). Reconcile the component's mirror state so the subtle
			// "Checking DNS…" indicator stops instead of spinning forever, and a
			// later domainsData tick can start a fresh poller.
			if (recheckDomainId === domainId) {
				recheckPoller = null;
				recheckDomainId = null;
				autoRecheckActive.value = false;
			}
		},
	});
	recheckPoller.start();
};

// Drive the poller from whichever panel is open and that domain's live status
// (domainsData is a real-time subscription, so a verify elsewhere collapses it).
watch([expandedDomainId, () => domainsData.value], () => {
	const id = expandedDomainId.value;
	const domain = id ? (domainsData.value ?? []).find((d) => d._id === id) : undefined;
	if (id && isAutoRecheckable(domain)) {
		startAutoRecheck(id);
	} else {
		stopAutoRecheck();
	}
});

onBeforeUnmount(() => {
	stopAutoRecheck();
});
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
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Sending Domains</h1>
					<p class="mt-1 text-text-secondary">
						Configure custom sending domains for better email deliverability
					</p>
				</div>
				<button class="btn btn-primary gap-2" @click="addModal.open()">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Add Domain
				</button>
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
			<p class="text-text-secondary font-medium">No team selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select a team to manage sending domains.
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-8">
			<!-- Info Card -->
			<div class="card p-6 bg-brand/5 border-brand/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:globe" size="sm" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">Why add a custom domain?</h3>
						<p class="text-sm text-text-secondary">
							Sending emails from your own domain improves deliverability and brand recognition.
							After adding a domain, configure the DNS records with your domain provider to verify
							ownership.
						</p>
					</div>
				</div>
			</div>

			<!-- Per-transport DNS guidance: what to check depends on how this
				 instance sends (managed MTA records vs SES/relay/Resend that sign on
				 your behalf). A sibling of — and demoted below — the "why add a
				 domain" card, so the first thing under the h1 builds the mental model,
				 not transports. The space-y-8 wrapper handles the spacing. -->
			<DeliveryDomainDnsGuidance />

			<!-- No verified domain → offer connecting an external mailbox instead -->
			<div
				v-if="isEnabled('mail.external') && !hasVerifiedDomain"
				class="card p-6 bg-bg-surface flex items-start gap-4"
			>
				<UiIconBox icon="lucide:mail-plus" size="sm" variant="surface" rounded="lg" />
				<div class="flex-1">
					<h3 class="font-medium text-text-primary mb-1">Don't have a domain to verify?</h3>
					<p class="text-sm text-text-secondary mb-3">
						Connect your existing mailbox (Gmail, Fastmail, a company server) over IMAP + SMTP to
						send and receive personal mail without registering a domain.
					</p>
					<NuxtLink to="/dashboard/postbox/migrate" class="btn btn-secondary btn-sm gap-2">
						<Icon name="lucide:mail-plus" class="w-4 h-4" />
						Connect external mailbox
					</NuxtLink>
				</div>
			</div>

			<!-- Empty State -->
			<div
				v-if="domainsData && domainsData.length === 0"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:globe" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No domains configured</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Add a custom sending domain to improve your email deliverability and brand recognition.
				</p>
				<button class="btn btn-primary gap-2 mt-4" @click="addModal.open()">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Add Your First Domain
				</button>
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
		<UiModal v-model:open="addModal.isOpen.value" title="Add Sending Domain">
			<DomainsAddDomainForm
				:loading="addModal.isLoading.value"
				@submit="handleAddDomain"
				@cancel="addModal.close()"
			/>
		</UiModal>

		<!-- Delete Domain Confirmation Modal -->
		<UiConfirmationDialog
			v-model:open="deleteModal.isOpen.value"
			title="Remove Domain"
			:description="`Are you sure you want to remove ${deleteModal.data.value?.domain}? You will no longer be able to send emails from this domain.`"
			confirm-text="Remove Domain"
			variant="danger"
			:is-loading="deleteModal.isLoading.value"
			@confirm="handleDeleteDomain"
		/>
	</div>
</template>
