<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { trySplitZone } from '@owlat/shared';
import { formatDateTime } from '~/utils/formatters';

// Tracking domains let an org serve open/click tracking from its own branded
// host (CNAME → the shared tracking endpoint) instead of the platform domain,
// which keeps links on-brand and avoids reputation cross-contamination. The
// backend (api.domains.trackingDomains.*) is already fully wired; this section
// is the admin UI for it and mirrors the Sending Domains section above.

// Recommended tracking subdomains (affordances, not an enum — the field stays
// free-form). Distinct from the sending flow's mail/post/send.
const TRACKING_SUGGESTIONS = ['track', 'links', 'click'] as const;

const { t } = useI18n();

const { hasActiveOrganization } = useOrganizationContext();

// Real-time list of tracking domains for the active org.
const { data: trackingDomains, isLoading } = useOrganizationQuery(
	api.domains.trackingDomains.listTrackingDomains
);

// Mutations / action, routed through the shared Operation module so they share
// the error vocabulary, toasts and telemetry policy used elsewhere.
const { run: addTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.addTrackingDomain,
	{ label: () => t('components.domains.trackingDomainsSection.operations.add') }
);
const { run: removeTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.removeTrackingDomain,
	{ label: () => t('components.domains.trackingDomainsSection.operations.remove') }
);
const { run: verifyTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.verifyTrackingDomain,
	{ label: () => t('components.domains.trackingDomainsSection.operations.verify') }
);

const { showToast } = useToast();

// Add modal. The body is the shared DomainsAddDomainForm (the same component the
// sending-domain flow uses) parameterized for tracking; it owns its own field
// state and re-initializes each time the modal opens (UiModal v-if's its slot),
// so there is nothing to reset here.
const addModal = useModal();

// Delete confirmation
const deleteModal = useConfirmModal<{ _id: Id<'trackingDomains'>; domain: string }>();

// Per-row verify spinner + expanded (DNS record) row
const verifyingId = ref<Id<'trackingDomains'> | null>(null);
const expandedId = ref<Id<'trackingDomains'> | null>(null);

const toggleExpansion = (id: Id<'trackingDomains'>) => {
	expandedId.value = expandedId.value === id ? null : id;
};

// The registrable zone a tracking domain's CNAME goes in — e.g. `example.com`
// for `track.example.com`. Fail-soft to the raw domain when it has no
// registrable zone (self-host / internal TLD).
const zoneFor = (domain: string) => trySplitZone(domain)?.registrable ?? domain;

// The guided form emits an object payload { domain, returnPathHost } (the shared
// contract with the sending flow). Tracking domains have no return path — the
// Advanced section is suppressed in the tracking context — so we consume only the
// composed, normalized domain string (`track.example.com`), parsed/composed via A1.
const handleAdd = async (payload: { domain: string; returnPathHost: string | null }) => {
	if (!hasActiveOrganization.value) return;

	addModal.setLoading(true);
	const result = await addTrackingDomain({ domain: payload.domain });
	addModal.setLoading(false);

	if (!result.ok) return;

	addModal.close();
	showToast(t('components.domains.trackingDomainsSection.toasts.added'));
};

const handleDelete = async () => {
	if (!deleteModal.data.value) return;

	deleteModal.setLoading(true);
	const result = await removeTrackingDomain({
		trackingDomainId: deleteModal.data.value._id,
	});
	deleteModal.setLoading(false);

	if (!result.ok) return;

	deleteModal.close();
	showToast(t('components.domains.trackingDomainsSection.toasts.removed'));
};

// Verify schedules a DNS check on the backend; the row flips to verified via the
// live query once the CNAME resolves. Expand the row so the CNAME to set is in
// view while DNS propagates.
const handleVerify = async (id: Id<'trackingDomains'>) => {
	verifyingId.value = id;
	try {
		const result = await verifyTrackingDomain({ trackingDomainId: id });
		if (!result.ok) return; // run() already surfaced the failure
		expandedId.value = id;
		showToast(t('components.domains.trackingDomainsSection.toasts.verifying'));
	} finally {
		verifyingId.value = null;
	}
};
</script>

<template>
	<div>
		<!-- Section header -->
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.domains.trackingDomainsSection.title') }}
				</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.domains.trackingDomainsSection.subtitle') }}
				</p>
			</div>
			<UiButton
				variant="secondary"
				v-if="hasActiveOrganization"
				class="gap-2"
				@click="addModal.open()"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.domains.trackingDomainsSection.addButton') }}
			</UiButton>
		</div>

		<!-- Info card -->
		<div class="card p-6 bg-brand/5 border-brand/20 mb-4">
			<div class="flex gap-4">
				<UiIconBox icon="lucide:link" size="sm" variant="brand" rounded="lg" />
				<div>
					<h3 class="font-medium text-text-primary mb-1">
						{{ t('components.domains.trackingDomainsSection.info.title') }}
					</h3>
					<I18nT
						keypath="components.domains.trackingDomainsSection.info.body"
						tag="p"
						scope="global"
						class="text-sm text-text-secondary"
					>
						<template #example>
							<code class="font-mono">
								{{ t('components.domains.trackingDomainsSection.info.exampleHost') }}
							</code>
						</template>
					</I18nT>
				</div>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading && !trackingDomains" class="flex items-center justify-center py-12">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('components.domains.trackingDomainsSection.loading') }}
				</p>
			</div>
		</div>

		<!-- Empty state -->
		<div
			v-else-if="trackingDomains && trackingDomains.length === 0"
			class="card flex flex-col items-center justify-center py-12 text-center px-6"
		>
			<UiIconBox icon="lucide:link" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('components.domains.trackingDomainsSection.empty.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('components.domains.trackingDomainsSection.empty.body') }}
			</p>
			<UiButton variant="secondary" class="gap-2 mt-4" @click="addModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('components.domains.trackingDomainsSection.empty.action') }}
			</UiButton>
		</div>

		<!-- List -->
		<div v-else-if="trackingDomains && trackingDomains.length > 0" class="space-y-4">
			<div v-for="td in trackingDomains" :key="td._id" class="card p-0 overflow-hidden">
				<!-- Row header -->
				<div
					class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors"
					@click="toggleExpansion(td._id)"
				>
					<div class="flex items-center gap-4">
						<UiIconBox icon="lucide:link" size="sm" variant="surface" rounded="lg" />
						<div>
							<div class="flex items-center gap-3">
								<p class="font-medium text-text-primary">{{ td.domain }}</p>
								<span
									:class="[
										'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
										td.isVerified
											? 'bg-success/20 text-success border-success/30'
											: 'bg-warning/20 text-warning border-warning/30',
									]"
								>
									<Icon
										:name="td.isVerified ? 'lucide:check-circle-2' : 'lucide:clock'"
										class="w-3 h-3"
									/>
									{{
										td.isVerified
											? t('components.domains.trackingDomainsSection.status.verified')
											: t('components.domains.trackingDomainsSection.status.pending')
									}}
								</span>
							</div>
							<p class="text-sm text-text-tertiary mt-0.5">
								<span v-if="td.isVerified && td.verifiedAt">
									{{
										t('components.domains.trackingDomainsSection.verifiedAt', {
											date: formatDateTime(td.verifiedAt),
										})
									}}
								</span>
								<span v-else>
									{{ t('components.domains.trackingDomainsSection.addCnameHint') }}
								</span>
							</p>
						</div>
					</div>

					<div class="flex items-center gap-2">
						<UiButton
							variant="secondary"
							class="gap-1.5 text-sm py-1.5 px-3"
							:title="t('components.domains.trackingDomainsSection.verifyTitle')"
							:disabled="verifyingId === td._id"
							@click.stop="handleVerify(td._id)"
						>
							<Icon
								v-if="verifyingId === td._id"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin motion-reduce:animate-none"
							/>
							<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
							{{
								verifyingId === td._id
									? t('components.domains.trackingDomainsSection.verifying')
									: t('components.domains.trackingDomainsSection.verify')
							}}
						</UiButton>
						<UiButton
							variant="ghost"
							class="p-2 text-error hover:bg-error/10"
							:title="t('components.domains.trackingDomainsSection.removeTitle')"
							@click.stop="deleteModal.open(td)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</UiButton>
						<div
							:class="[
								'w-5 h-5 flex items-center justify-center transition-transform',
								expandedId === td._id ? 'rotate-180' : '',
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

				<!-- DNS record (expanded) -->
				<Transition name="expand">
					<div v-if="expandedId === td._id" class="border-t border-border-subtle">
						<div class="px-6 py-4 bg-bg-surface/30">
							<I18nT
								keypath="components.domains.trackingDomainsSection.cnameHeading"
								tag="h4"
								scope="global"
								class="text-sm font-medium text-text-primary mb-4"
							>
								<template #zone>
									<strong>{{ zoneFor(td.domain) }}</strong>
								</template>
							</I18nT>
							<DomainsDNSRecordPanel
								:record="{ type: 'CNAME', host: '@', value: td.cnameTarget }"
								:label="t('components.domains.trackingDomainsSection.recordLabel')"
								:domain="td.domain"
								:verification="{ verified: td.isVerified }"
							/>
							<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
								<I18nT
									keypath="components.domains.trackingDomainsSection.note.body"
									tag="p"
									scope="global"
									class="text-sm text-text-secondary"
								>
									<template #note>
										<strong class="text-text-primary">
											{{ t('components.domains.trackingDomainsSection.note.label') }}
										</strong>
									</template>
								</I18nT>
							</div>
						</div>
					</div>
				</Transition>
			</div>
		</div>

		<!-- Add modal — the SAME guided two-field picker the sending-domain flow
		     uses (DomainsAddDomainForm), parameterized for tracking: track/links/
		     click suggestions, a tracking-URL preview, no freemail block, and no
		     sending-apex note. One component, no fork. -->
		<UiModal
			v-model:open="addModal.isOpen.value"
			:title="t('components.domains.trackingDomainsSection.addModalTitle')"
		>
			<DomainsAddDomainForm
				context="tracking"
				:loading="addModal.isLoading.value"
				:suggestions="TRACKING_SUGGESTIONS"
				default-subdomain="track"
				:subdomain-label="t('components.domains.trackingDomainsSection.form.subdomainLabel')"
				:subdomain-hint="t('components.domains.trackingDomainsSection.form.subdomainHint')"
				:subdomain-placeholder="
					t('components.domains.trackingDomainsSection.form.subdomainPlaceholder')
				"
				:block-freemail="false"
				:show-apex-note="false"
				:submit-label="t('components.domains.trackingDomainsSection.form.submitLabel')"
				@submit="handleAdd"
				@cancel="addModal.close()"
			/>
		</UiModal>

		<!-- Delete confirmation -->
		<UiConfirmationDialog
			v-model:open="deleteModal.isOpen.value"
			:title="t('components.domains.trackingDomainsSection.delete.title')"
			:description="
				t('components.domains.trackingDomainsSection.delete.description', {
					domain: deleteModal.data.value?.domain ?? '',
				})
			"
			:confirm-text="t('components.domains.trackingDomainsSection.delete.confirm')"
			variant="danger"
			:is-loading="deleteModal.isLoading.value"
			@confirm="handleDelete"
		/>
	</div>
</template>

<style scoped>
/* Expand transition (mirrors the Sending Domains rows) */
.expand-enter-active,
.expand-leave-active {
	transition: all var(--motion-moderate) var(--ease-spring);
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
