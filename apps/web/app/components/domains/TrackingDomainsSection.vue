<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatDateTime } from '~/utils/formatters';
import { rules } from '~/composables/useFormValidation';

// Tracking domains let an org serve open/click tracking from its own branded
// host (CNAME → the shared tracking endpoint) instead of the platform domain,
// which keeps links on-brand and avoids reputation cross-contamination. The
// backend (api.domains.trackingDomains.*) is already fully wired; this section
// is the admin UI for it and mirrors the Sending Domains section above.

const { hasActiveOrganization } = useOrganizationContext();

// Real-time list of tracking domains for the active org.
const { data: trackingDomains, isLoading } = useOrganizationQuery(
	api.domains.trackingDomains.listTrackingDomains,
);

// Mutations / action, routed through the shared Operation module so they share
// the error vocabulary, toasts and telemetry policy used elsewhere.
const { run: addTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.addTrackingDomain,
	{ label: 'Add tracking domain' },
);
const { run: removeTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.removeTrackingDomain,
	{ label: 'Remove tracking domain' },
);
const { run: verifyTrackingDomain } = useBackendOperation(
	api.domains.trackingDomains.verifyTrackingDomain,
	{ label: 'Verify tracking domain' },
);

const { showToast } = useToast();

// Add modal
const addModal = useModal({
	onClose: () => {
		addForm.domain = '';
		validation.reset();
	},
});

const addForm = reactive({
	domain: '',
});

const validation = useFormValidation({
	domain: [
		rules.required('Domain is required'),
		rules.domain('Please enter a valid domain name (e.g., track.example.com)'),
	],
});

// Delete confirmation
const deleteModal = useConfirmModal<{ _id: Id<'trackingDomains'>; domain: string }>();

// Per-row verify spinner + expanded (DNS record) row
const verifyingId = ref<Id<'trackingDomains'> | null>(null);
const expandedId = ref<Id<'trackingDomains'> | null>(null);

const toggleExpansion = (id: Id<'trackingDomains'>) => {
	expandedId.value = expandedId.value === id ? null : id;
};

const handleAdd = async () => {
	if (!hasActiveOrganization.value) return;
	if (!validation.validate(addForm)) return;

	addModal.setLoading(true);
	const result = await addTrackingDomain({
		domain: addForm.domain.trim().toLowerCase(),
	});
	addModal.setLoading(false);

	if (result === undefined) return;

	addModal.close();
	showToast('Tracking domain added. Add the CNAME record below, then verify.');
};

const handleDelete = async () => {
	if (!deleteModal.data.value) return;

	deleteModal.setLoading(true);
	const result = await removeTrackingDomain({
		trackingDomainId: deleteModal.data.value._id,
	});
	deleteModal.setLoading(false);

	if (result === undefined) return;

	deleteModal.close();
	showToast('Tracking domain removed');
};

// Verify schedules a DNS check on the backend; the row flips to verified via the
// live query once the CNAME resolves. Expand the row so the CNAME to set is in
// view while DNS propagates.
const handleVerify = async (id: Id<'trackingDomains'>) => {
	verifyingId.value = id;
	try {
		const result = await verifyTrackingDomain({ trackingDomainId: id });
		if (result === undefined) return; // run() already surfaced the failure
		expandedId.value = id;
		showToast(
			'Checking DNS for this tracking domain. It will show as verified once the CNAME resolves.',
		);
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
				<h2 class="text-lg font-semibold text-text-primary">Tracking Domains</h2>
				<p class="mt-1 text-sm text-text-secondary">
					Serve open &amp; click tracking from your own branded subdomain
				</p>
			</div>
			<button
				v-if="hasActiveOrganization"
				class="btn btn-secondary gap-2"
				@click="addModal.open()"
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add Tracking Domain
			</button>
		</div>

		<!-- Info card -->
		<div class="card p-6 bg-brand/5 border-brand/20 mb-4">
			<div class="flex gap-4">
				<UiIconBox icon="lucide:link" size="sm" variant="brand" rounded="lg" />
				<div>
					<h3 class="font-medium text-text-primary mb-1">Why use a tracking domain?</h3>
					<p class="text-sm text-text-secondary">
						Links in your emails are rewritten through a tracking host so opens and clicks can be
						measured. Pointing that host at your own subdomain keeps links on-brand and isolates
						your sending reputation. Add a subdomain like <code class="font-mono">track.example.com</code>,
						create the CNAME record we show you, then verify.
					</p>
				</div>
			</div>
		</div>

		<!-- Loading -->
		<div v-if="isLoading && !trackingDomains" class="flex items-center justify-center py-12">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading tracking domains...</p>
			</div>
		</div>

		<!-- Empty state -->
		<div
			v-else-if="trackingDomains && trackingDomains.length === 0"
			class="card flex flex-col items-center justify-center py-12 text-center px-6"
		>
			<UiIconBox icon="lucide:link" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No tracking domains configured</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Add a branded subdomain to serve open and click tracking from your own domain.
			</p>
			<button class="btn btn-secondary gap-2 mt-4" @click="addModal.open()">
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add Your First Tracking Domain
			</button>
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
									{{ td.isVerified ? 'Verified' : 'Pending' }}
								</span>
							</div>
							<p class="text-sm text-text-tertiary mt-0.5">
								<span v-if="td.isVerified && td.verifiedAt">
									Verified {{ formatDateTime(td.verifiedAt) }}
								</span>
								<span v-else>
									Add the CNAME record, then click Verify
								</span>
							</p>
						</div>
					</div>

					<div class="flex items-center gap-2">
						<button
							class="btn btn-secondary gap-1.5 text-sm py-1.5 px-3"
							title="Check DNS for this tracking domain"
							:disabled="verifyingId === td._id"
							@click.stop="handleVerify(td._id)"
						>
							<Icon
								v-if="verifyingId === td._id"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin"
							/>
							<Icon v-else name="lucide:refresh-cw" class="w-4 h-4" />
							{{ verifyingId === td._id ? 'Verifying...' : 'Verify' }}
						</button>
						<button
							class="btn btn-ghost p-2 text-error hover:bg-error/10"
							title="Remove tracking domain"
							@click.stop="deleteModal.open(td)"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
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
							<h4 class="text-sm font-medium text-text-primary mb-4">
								Create this CNAME record with your domain provider:
							</h4>
							<DomainsDNSRecordPanel
								:record="{ type: 'CNAME', host: '@', value: td.cnameTarget }"
								label="Tracking"
								:domain="td.domain"
								:verification="{ verified: td.isVerified }"
							/>
							<div class="mt-4 p-4 bg-bg-surface rounded-xl border border-border-subtle">
								<p class="text-sm text-text-secondary">
									<strong class="text-text-primary">Note:</strong> DNS changes can take up to 48
									hours to propagate. After adding the record, click "Verify" to check the
									configuration.
								</p>
							</div>
						</div>
					</div>
				</Transition>
			</div>
		</div>

		<!-- Add modal -->
		<UiModal v-model:open="addModal.isOpen.value" title="Add Tracking Domain">
			<form @submit.prevent="handleAdd">
				<div class="space-y-4">
					<div>
						<label for="tracking-domain-name" class="label">
							Domain Name <span class="text-error">*</span>
						</label>
						<input
							id="tracking-domain-name"
							v-model="addForm.domain"
							type="text"
							placeholder="track.example.com"
							:class="['input', validation.hasError('domain') && 'input-error']"
							:disabled="addModal.isLoading.value"
							@blur="validation.touch('domain')"
						/>
						<p v-if="validation.getError('domain', true)" class="mt-1 text-xs text-error">
							{{ validation.getError('domain', true) }}
						</p>
						<p v-else class="mt-1 text-xs text-text-tertiary">
							Enter a subdomain to use for click/open tracking, e.g. track.example.com.
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
						<Icon
							v-if="addModal.isLoading.value"
							name="lucide:loader-2"
							class="w-4 h-4 animate-spin"
						/>
						<Icon v-else name="lucide:plus" class="w-4 h-4" />
						{{ addModal.isLoading.value ? 'Adding...' : 'Add Tracking Domain' }}
					</button>
				</div>
			</form>
		</UiModal>

		<!-- Delete confirmation -->
		<UiConfirmationDialog
			v-model:open="deleteModal.isOpen.value"
			title="Remove Tracking Domain"
			:description="`Are you sure you want to remove ${deleteModal.data.value?.domain}? Tracking links will fall back to the platform domain.`"
			confirm-text="Remove Tracking Domain"
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
