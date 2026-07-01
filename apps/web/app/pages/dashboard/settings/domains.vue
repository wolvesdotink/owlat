<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';
import { hasInboundFeature } from '~/utils/inboundDns';
import { computeSpfSuggestion, type SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';
import { summarizeDomainReadiness, domainReadinessMessage } from '~/utils/domainReadiness';
import { createAutoRecheckPoller, type AutoRecheckPoller } from '~/utils/domainAutoRecheck';
import { rules } from '~/composables/useFormValidation';

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
const { isEnabled, flags } = useFeatureFlag();
const hasVerifiedDomain = computed(() =>
	(domainsData.value ?? []).some((d) => d.status === 'verified'),
);

// Mutations
const { run: createDomain } = useBackendOperation(api.domains.domains.create, {
	label: 'Add domain',
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
const canForceVerify = computed(() => isDevBuild && (role.value === 'owner' || role.value === 'admin'));

const forcingDomainId = ref<Id<'domains'> | null>(null);

// Toast notifications
const { showToast } = useToast();

// Add domain modal
const addModal = useModal({
	onClose: () => {
		addForm.domain = '';
		validation.reset();
	},
});

// Delete confirmation modal
const deleteModal = useConfirmModal<{ _id: Id<'domains'>; domain: string }>();

// Form state
const addForm = reactive({
	domain: '',
});

// Form validation
const validation = useFormValidation({
	domain: [
		rules.required('Domain is required'),
		rules.domain('Please enter a valid domain name (e.g., mail.example.com)'),
	],
});

// Verification state
const verifyingDomainId = ref<Id<'domains'> | null>(null);

// Expanded domain (showing DNS records)
const expandedDomainId = ref<Id<'domains'> | null>(null);

// Handle add domain
const handleAddDomain = async () => {
	if (!hasActiveOrganization.value) return;
	if (!validation.validate(addForm)) return;

	addModal.setLoading(true);
	const result = await createDomain({
		domain: addForm.domain.trim().toLowerCase(),
	});
	addModal.setLoading(false);

	if (result === undefined) return;

	addModal.close();
	showToast('Domain added successfully. Configure your DNS records to verify.');
};

// Handle delete domain
const handleDeleteDomain = async () => {
	if (!deleteModal.data.value) return;

	deleteModal.setLoading(true);
	const result = await removeDomain({
		domainId: deleteModal.data.value._id,
	});
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
type DmarcPolicy = 'none' | 'quarantine' | 'reject';
const canManageDomains = computed(() => role.value === 'owner' || role.value === 'admin');

// Inbound/receiving DNS guidance. `getInboundMailConfig` is admin-gated
// (organization:manage), so skip the subscription for non-admins — the read
// would otherwise fail with `forbidden`, and the Receiving panel is an operator
// task anyway. Returns the deployment's mail host (MTA EHLO hostname) used as
// the MX target plus the inbound SMTP port.
const { data: inboundMailConfig } = useConvexQuery(
	api.domains.domains.getInboundMailConfig,
	() => (canManageDomains.value ? {} : 'skip'),
);
// Show the Receiving (MX) section only when an inbound feature flag is active
// AND the deployment has a mail host to point at — mirrors how the sending
// panels gate, so a send-only install never sees inbound noise.
const showReceivingDns = computed(
	() => hasInboundFeature(flags.value) && Boolean(inboundMailConfig.value?.mailHost),
);
const dmarcPolicyOptions: { value: DmarcPolicy; label: string; hint: string }[] = [
	{ value: 'none', label: 'Monitor only (p=none)', hint: 'Collect reports, take no action on failures.' },
	{ value: 'quarantine', label: 'Quarantine (p=quarantine)', hint: 'Send failing mail to spam.' },
	{ value: 'reject', label: 'Reject (p=reject)', hint: 'Reject failing mail outright — full enforcement.' },
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
				: `DMARC policy raised to ${policy}. Re-publish the updated _dmarc record, then verify.`,
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
watch(
	[expandedDomainId, () => domainsData.value],
	() => {
		const id = expandedDomainId.value;
		const domain = id ? (domainsData.value ?? []).find((d) => d._id === id) : undefined;
		if (id && isAutoRecheckable(domain)) {
			startAutoRecheck(id);
		} else {
			stopAutoRecheck();
		}
	},
);

onBeforeUnmount(() => {
	stopAutoRecheck();
});

// Status badge styling
const getStatusBadgeClass = (status: string) => {
	switch (status) {
		case 'verified':
			return 'bg-success/20 text-success border-success/30';
		case 'failed':
			return 'bg-error/20 text-error border-error/30';
		case 'registering':
			return 'bg-info/20 text-info border-info/30';
		default:
			return 'bg-warning/20 text-warning border-warning/30';
	}
};

// Status icons
const statusIcons: Record<string, string> = {
	verified: 'lucide:check-circle-2',
	failed: 'lucide:x-circle',
	pending: 'lucide:clock',
	registering: 'lucide:loader-2',
};

const getStatusIcon = (status: string): string => {
	return statusIcons[status] || statusIcons['pending']!;
};

type DnsRecord = {
	type?: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host?: string;
	hostname?: string;
	value: string;
	priority?: number;
	usage?: number;
	selector?: number;
	matchingType?: number;
};

type DnsRecordPanelRecord = {
	type: 'TXT' | 'CNAME' | 'MX' | 'TLSA';
	host: string;
	value: string;
};

type DomainDnsRecords = {
	spf?: DnsRecord;
	dkim?: DnsRecord[];
	dmarc?: DnsRecord;
	mailFrom?: DnsRecord[];
	tlsRpt?: DnsRecord;
};

const normalizeDnsRecord = (
	record: DnsRecord | null | undefined,
	fallbackType: DnsRecordPanelRecord['type']
): DnsRecordPanelRecord | null => {
	if (!record?.value) return null;

	return {
		type: record.type ?? fallbackType,
		host: record.host ?? record.hostname ?? '@',
		value: record.value,
	};
};

const hasDnsRecords = (dnsRecords: DomainDnsRecords | null | undefined): dnsRecords is DomainDnsRecords => {
	if (!dnsRecords) return false;
	return Boolean(
		dnsRecords.spf ||
			dnsRecords.dkim?.length ||
			dnsRecords.dmarc ||
			dnsRecords.mailFrom?.length
	);
};

// One-line readiness summary for the expanded DNS panel — pure composition of
// the verification data already on the domain (no extra query / lookup).
type DomainWithVerification = {
	dnsRecords?: DomainDnsRecords | null;
	verificationResults?: Parameters<typeof summarizeDomainReadiness>[0];
};
const readinessSummary = (domain: DomainWithVerification) =>
	summarizeDomainReadiness(domain.verificationResults, domain.dnsRecords);
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
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

		<!-- Loading State -->
		<div v-if="isLoading && !domainsData" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading domains...</p>
			</div>
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
					<NuxtLink
						to="/dashboard/postbox/settings/external-account"
						class="btn btn-secondary btn-sm gap-2"
					>
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
				<div v-for="domain in domainsData" :key="domain._id" class="card p-0 overflow-hidden">
					<!-- Domain Header -->
					<div
						class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors"
						@click="toggleDomainExpansion(domain._id)"
					>
						<div class="flex items-center gap-4">
							<UiIconBox icon="lucide:globe" size="sm" variant="surface" rounded="lg" />
							<div>
								<div class="flex items-center gap-3">
									<p class="font-medium text-text-primary">{{ domain.domain }}</p>
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
											getStatusBadgeClass(domain.status),
										]"
									>
										<Icon
											:name="getStatusIcon(domain.status)"
											:class="['w-3 h-3', domain.status === 'registering' && 'animate-spin']"
										/>
										{{ domain.status.charAt(0).toUpperCase() + domain.status.slice(1) }}
									</span>
								</div>
								<p class="text-sm text-text-tertiary mt-0.5">
									<span v-if="domain.status === 'registering'">
										Setting up domain...
									</span>
									<span
										v-else-if="
											domain.status === 'failed' && (domain.lastRegistrationError)
										"
									>
										Registration failed — click Retry to try again
									</span>
									<span v-else-if="domain.status === 'verified'">
										Verified {{ formatDateTime(domain.verifiedAt) }}
									</span>
									<span v-else-if="domain.lastVerifiedAt">
										Last checked {{ formatDateTime(domain.lastVerifiedAt) }}
									</span>
									<span v-else> Added {{ formatDateTime(domain.createdAt) }} </span>
								</p>
							</div>
						</div>

						<div class="flex items-center gap-2">
							<button
								v-if="canForceVerify && domain.status !== 'verified'"
								class="btn gap-1.5 text-sm py-1.5 px-3 border border-yellow-500/40 bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 dark:text-yellow-300"
								title="Skip DNS verification and mark this domain as verified — dev/selfhost only"
								:disabled="forcingDomainId === domain._id"
								@click.stop="handleForceVerify(domain._id)"
							>
								<Icon
									v-if="forcingDomainId === domain._id"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin"
								/>
								<Icon v-else name="lucide:wand-2" class="w-4 h-4" />
								Force Verify
								<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/30 uppercase tracking-wide">
									Dev
								</span>
							</button>
							<button
								class="btn btn-secondary gap-1.5 text-sm py-1.5 px-3"
								:title="domain.status === 'registering' ? 'Waiting for registration...' : 'Verify DNS records'"
								:disabled="verifyingDomainId === domain._id || domain.status === 'registering'"
								@click.stop="domain.status === 'failed' && (domain.lastRegistrationError) ? handleRetryRegistration(domain._id) : handleVerifyDomain(domain._id)"
							>
								<Icon v-if="verifyingDomainId === domain._id || domain.status === 'registering'" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
								<template v-if="domain.status === 'registering'">Registering...</template>
								<template v-else-if="domain.status === 'failed' && (domain.lastRegistrationError)">Retry</template>
								<template v-else>{{ verifyingDomainId === domain._id ? 'Verifying...' : 'Verify' }}</template>
							</button>
							<button
								class="btn btn-ghost p-2 text-error hover:bg-error/10"
								title="Remove domain"
								@click.stop="deleteModal.open(domain)"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</button>
							<div
								:class="[
									'w-5 h-5 flex items-center justify-center transition-transform',
									expandedDomainId === domain._id ? 'rotate-180' : '',
								]"
							>
								<svg
									class="w-4 h-4 text-text-tertiary"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 9l-7 7-7-7"
									/>
								</svg>
							</div>
						</div>
					</div>

					<!-- DNS Records (Expanded) -->
					<Transition name="expand">
						<div v-if="expandedDomainId === domain._id" class="border-t border-border-subtle">
							<div class="px-6 py-4 bg-bg-surface/30">
								<!-- Registering state -->
								<div
									v-if="domain.status === 'registering'"
									class="flex items-center gap-3 py-8 justify-center"
								>
									<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-info" />
									<p class="text-sm text-text-secondary">
										Setting up domain. DNS records will appear shortly...
									</p>
								</div>

								<!-- Registration error -->
								<div
									v-else-if="domain.status === 'failed' && (domain.lastRegistrationError)"
									class="py-4"
								>
									<div class="p-4 bg-error/5 border border-error/20 rounded-xl mb-4">
										<p class="text-sm text-error font-medium mb-1">
											Registration Failed
										</p>
										<p class="text-sm text-text-secondary">
											{{ domain.lastRegistrationError }}
										</p>
									</div>
									<button
										class="btn btn-primary gap-2"
										@click="handleRetryRegistration(domain._id)"
									>
										<Icon name="lucide:refresh-cw" class="w-4 h-4" />
										Retry Registration
									</button>
								</div>

								<!-- DNS records (normal state) -->
								<template v-else-if="hasDnsRecords(domain.dnsRecords)">
									<div class="flex items-center justify-between gap-3 mb-4">
										<h4 class="text-sm font-medium text-text-primary">
											Configure these DNS records with your domain provider:
										</h4>
										<!-- Subtle auto-recheck indicator: we quietly re-verify while
										     this panel is open so the user needn't keep clicking Verify. -->
										<span
											v-if="autoRecheckActive && expandedDomainId === domain._id"
											class="inline-flex items-center gap-1.5 text-xs text-text-secondary whitespace-nowrap"
											title="We recheck your DNS automatically every 30 seconds while this panel is open."
										>
											<Icon name="lucide:loader-2" class="w-3 h-3 animate-spin" />
											Checking DNS…
										</span>
									</div>

									<!-- One-line domain readiness summary derived purely from the
									     verification data already on the domain. -->
									<div
										v-if="readinessSummary(domain).total > 0"
										class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4 text-sm"
									>
										<div class="flex flex-wrap items-center gap-1.5">
											<span
												v-for="chip in readinessSummary(domain).chips"
												:key="chip.label"
												class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-medium"
												:class="
													chip.verified
														? 'bg-success/20 text-success border-success/30'
														: 'bg-error/20 text-error border-error/30'
												"
											>
												<Icon
													:name="chip.verified ? 'lucide:check-circle-2' : 'lucide:x-circle'"
													class="w-3 h-3"
												/>
												{{ chip.label }}
											</span>
										</div>
										<span
											:class="
												readinessSummary(domain).allVerified
													? 'text-success'
													: 'text-text-secondary'
											"
										>
											{{ domainReadinessMessage(readinessSummary(domain)) }}
										</span>
									</div>

									<div class="space-y-4">
										<DomainsDNSRecordPanel
											v-if="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')"
											:record="normalizeDnsRecord(domain.dnsRecords.spf, 'TXT')!"
											label="SPF"
											:domain="domain.domain"
											:verification="domain.verificationResults?.spf"
											:coexistence="expandedDomainId === domain._id ? (spfCoexistence ?? undefined) : undefined"
										/>

										<DomainsDNSRecordPanel
											v-for="(dkimRecord, i) in domain.dnsRecords.dkim"
											:key="`dkim-${i}`"
											:record="normalizeDnsRecord(dkimRecord, 'CNAME')!"
											:label="`DKIM ${i + 1}`"
											:domain="domain.domain"
											:verification="domain.verificationResults?.dkim?.[i]"
										/>

										<DomainsDNSRecordPanel
											v-if="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')"
											:record="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')!"
											label="DMARC"
											:domain="domain.domain"
											:verification="domain.verificationResults?.dmarc"
										/>

										<!-- DMARC enforcement policy selector -->
										<div
											v-if="normalizeDnsRecord(domain.dnsRecords.dmarc, 'TXT')"
											class="p-4 bg-bg-surface rounded-xl border border-border-subtle"
										>
											<label
												:for="`dmarc-policy-${domain._id}`"
												class="block text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2"
											>
												DMARC enforcement policy
											</label>
											<div class="flex items-center gap-3">
												<select
													:id="`dmarc-policy-${domain._id}`"
													class="input flex-1"
													:value="domain.dmarcPolicy ?? 'none'"
													:disabled="!canManageDomains || updatingDmarcDomainId === domain._id"
													@change="handleDmarcPolicyChange(domain._id, ($event.target as HTMLSelectElement).value as DmarcPolicy)"
												>
													<option
														v-for="opt in dmarcPolicyOptions"
														:key="opt.value"
														:value="opt.value"
													>
														{{ opt.label }}
													</option>
												</select>
												<Icon
													v-if="updatingDmarcDomainId === domain._id"
													name="lucide:loader-2"
													class="w-4 h-4 animate-spin text-text-tertiary"
												/>
											</div>
											<p class="mt-2 text-xs text-text-secondary">
												{{ dmarcPolicyOptions.find((o) => o.value === (domain.dmarcPolicy ?? 'none'))?.hint }}
												Start at monitor-only, then raise to quarantine or reject once
												SPF + DKIM are aligned. Changing this updates the _dmarc record
												above — re-publish it and verify again.
											</p>
										</div>

										<!-- MAIL FROM records -->
										<template
											v-if="
												domain.dnsRecords.mailFrom &&
												domain.dnsRecords.mailFrom.length > 0
											"
										>
											<div class="pt-2">
												<p
													class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3"
												>
													MAIL FROM Domain (mail.{{ domain.domain }})
												</p>
												<div class="space-y-4">
													<DomainsDNSRecordPanel
														v-for="(mailFromRecord, i) in domain.dnsRecords.mailFrom"
														:key="`mailfrom-${i}`"
														:record="normalizeDnsRecord(mailFromRecord, mailFromRecord.type === 'MX' ? 'MX' : 'TXT')!"
														:label="mailFromRecord.type === 'MX' ? 'MAIL FROM MX' : 'MAIL FROM SPF'"
														:domain="domain.domain"
														:verification="domain.verificationResults?.mailFrom?.[i]"
													/>
												</div>
											</div>
										</template>
									</div>
								</template>

								<!-- Receiving (inbound MX) — only when an inbound feature flag is on
								     and the deployment exposes a mail host to point at. -->
								<div
									v-if="
										showReceivingDns &&
										domain.status !== 'registering' &&
										!(domain.status === 'failed' && domain.lastRegistrationError)
									"
									class="mt-4 pt-4 border-t border-border-subtle"
								>
									<DomainsReceivingDnsSection
										:domain="domain.domain"
										:mail-host="inboundMailConfig?.mailHost ?? null"
										:inbound-port="inboundMailConfig?.inboundPort ?? 25"
									/>
								</div>

								<!-- Help Text -->
								<div
									v-if="domain.status !== 'registering' && !(domain.status === 'failed' && (domain.lastRegistrationError))"
									class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle"
								>
									<p class="text-sm text-text-secondary">
										<strong class="text-text-primary">Note:</strong> DNS changes can take up to 48
										hours to propagate. After adding these records, click "Verify Domain" to check
										the configuration.
										<a
											href="https://docs.owlat.app/developer/self-hosting-dns-email"
											target="_blank"
											rel="noopener noreferrer"
											class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
										>
											Learn more
											<Icon name="lucide:external-link" class="w-3 h-3" />
										</a>
									</p>
								</div>
							</div>
						</div>
					</Transition>
				</div>
			</div>

			<!-- Tracking Domains (branded open/click tracking) -->
			<div class="pt-2 border-t border-border-subtle">
				<DomainsTrackingDomainsSection />
			</div>
		</div>

		<!-- Add Domain Modal -->
		<UiModal v-model:open="addModal.isOpen.value" title="Add Sending Domain">
			<form @submit.prevent="handleAddDomain">
				<div class="space-y-4">
					<div>
						<label for="domain-name" class="label">
							Domain Name <span class="text-error">*</span>
						</label>
						<input
							id="domain-name"
							v-model="addForm.domain"
							type="text"
							placeholder="mail.example.com"
							:class="['input', validation.hasError('domain') && 'input-error']"
							:disabled="addModal.isLoading.value"
							@blur="validation.touch('domain')"
						/>
						<p v-if="validation.getError('domain', true)" class="mt-1 text-xs text-error">
							{{ validation.getError('domain', true) }}
						</p>
						<p v-else class="mt-1 text-xs text-text-tertiary">
							Enter the domain you want to use for sending emails. We recommend using a subdomain
							like mail.example.com.
						</p>
					</div>
				</div>

				<div class="flex justify-end gap-3 mt-6">
					<button
						type="button"
						class="btn btn-secondary"
						:disabled="addModal.isLoading.value"
						@click="addModal.close()"
					>
						Cancel
					</button>
					<button type="submit" class="btn btn-primary gap-2" :disabled="addModal.isLoading.value">
						<Icon v-if="addModal.isLoading.value" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
						<Icon v-else name="lucide:plus" class="w-4 h-4" />
						{{ addModal.isLoading.value ? 'Adding...' : 'Add Domain' }}
					</button>
				</div>
			</form>
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

<style scoped>
/* Expand transition */
.expand-enter-active,
.expand-leave-active {
	transition: all 0.2s ease;
	overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
	opacity: 0;
	max-height: 0;
}

.expand-enter-to,
.expand-leave-from {
	max-height: 1000px;
}
</style>
