<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';
import { type BlockReason, suppressionReasonPresentation } from '~/utils/suppressionReasons';
import {
	indexSuppressionProvenance,
	suppressionProvenanceLine,
} from '~/utils/suppressionProvenance';

useHead({ title: 'Suppressions — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();
const { isAdmin: canManageSunset } = usePermissions();

const sunsetPage = { numItems: 100, cursor: null } as const;
const { data: sunsetPolicies } = useConvexQuery(api.contacts.sunset.getSunsetPolicies, () =>
	canManageSunset.value ? {} : 'skip'
);
const { data: reengagementContacts } = useConvexQuery(api.contacts.sunset.listSunsetStage, () =>
	canManageSunset.value ? { stage: 'reengagement' as const, paginationOpts: sunsetPage } : 'skip'
);
const { data: sunsetSuppressedContacts } = useConvexQuery(
	api.contacts.sunset.listSunsetStage,
	() =>
		canManageSunset.value ? { stage: 'suppressed' as const, paginationOpts: sunsetPage } : 'skip'
);

const sunsetPolicyForm = reactive({
	isEnabled: true,
	reengageAfterDays: 180,
	suppressAfterDays: 270,
});
watch(
	sunsetPolicies,
	(value) => {
		if (!value) return;
		sunsetPolicyForm.isEnabled = value.global.isEnabled;
		sunsetPolicyForm.reengageAfterDays = value.global.reengageAfterDays;
		sunsetPolicyForm.suppressAfterDays = value.global.suppressAfterDays;
	},
	{ immediate: true }
);

// Filter state
const reasonFilter = ref<'all' | BlockReason>('all');

// Get blocked emails with real-time updates
const {
	data: blockedEmailsData,
	isLoading: blockedEmailsLoading,
	error: blockedEmailsError,
} = useOrganizationQuery(api.blockedEmails.listByTeam, () => ({
	reason: reasonFilter.value === 'all' ? undefined : reasonFilter.value,
}));

// Get counts by reason
const { data: countsData } = useOrganizationQuery(api.blockedEmails.getCountsByReason);

// WHO PUT THIS HERE. A `manual` row can be a colleague's decision or a provider
// blacklist hit mirrored in with nobody behind it (plan D9); the audit entry is
// what tells them apart. Admin-gated, so it simply stays empty for a member and
// the column falls back to saying nothing.
const { data: provenanceData } = useOrganizationQuery(api.blockedEmails.listProviderProvenance);
const provenanceById = computed(() => indexSuppressionProvenance(provenanceData.value));
const provenanceFor = (blockedEmailId: string): string | null =>
	suppressionProvenanceLine(provenanceById.value.get(blockedEmailId));

const isLoading = computed(() => organizationLoading.value || blockedEmailsLoading.value);

// Mutations
const { run: addBlockedEmail } = useBackendOperation(api.blockedEmails.add, {
	label: 'Add to blocklist',
});
const { run: removeBlockedEmail } = useBackendOperation(api.blockedEmails.remove, {
	label: 'Remove from blocklist',
});
const { run: bulkAddBlockedEmails } = useBackendOperation(api.blockedEmails.bulkAdd, {
	label: 'Import blocklist',
});
const { run: setSunsetPolicy, isLoading: isSavingSunsetPolicy } = useBackendOperation(
	api.contacts.sunset.setSunsetPolicy,
	{ label: 'Save sunset policy' }
);
const { run: setSunsetContactExemption } = useBackendOperation(
	api.contacts.sunset.setSunsetContactExemption,
	{ label: 'Change sunset exemption' }
);
const { run: restoreSunsetContact } = useBackendOperation(
	api.contacts.sunset.restoreSunsetContact,
	{ label: 'Restore sunset contact' }
);

const saveSunsetPolicy = async () => {
	const saved = await setSunsetPolicy({ ...sunsetPolicyForm });
	if (saved !== undefined) showNotification('Sunset policy saved');
};

const toggleSunsetExemption = async (contactId: Id<'contacts'>, exempt: boolean) => {
	const changed = await setSunsetContactExemption({ contactId, exempt });
	if (changed !== undefined) showNotification(exempt ? 'Contact exempted' : 'Exemption removed');
};

const restoreSunset = async (contactId: Id<'contacts'>) => {
	const result = await restoreSunsetContact({ contactId });
	if (result?.outcome === 'restored') showNotification('Contact restored and exempted');
};

// Bulk import from a CSV / text file → blockedEmails.bulkAdd
const blocklistImport = useBlocklistImport();

const handleImportBlocklist = async () => {
	if (!hasActiveOrganization.value) return;

	const result = await blocklistImport.startImport((emails) => bulkAddBlockedEmails({ emails }));
	if (result === undefined) return;

	const { added, skipped } = result;
	showNotification(
		added > 0
			? `Imported ${added} address${added === 1 ? '' : 'es'}${skipped > 0 ? ` (${skipped} skipped)` : ''}`
			: 'No new addresses added — all were already suppressed or invalid'
	);
};

// Search state
const searchQuery = ref('');

// Filtered blocked emails based on search
const filteredBlockedEmails = computed(() => {
	if (!blockedEmailsData.value) return [];
	if (!searchQuery.value.trim()) return blockedEmailsData.value;

	const query = searchQuery.value.toLowerCase().trim();
	return blockedEmailsData.value.filter(
		(be) =>
			be.email.toLowerCase().includes(query) || (be.notes && be.notes.toLowerCase().includes(query))
	);
});

// Add modal using useFormModal
const addModal = useFormModal({
	email: '',
	notes: '',
});

// Delete modal state
const emailToDelete = ref<{
	_id: Id<'blockedEmails'>;
	email: string;
} | null>(null);
const isDeleting = ref(false);

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Validate add form
const validateAddForm = (): boolean => {
	addModal.clearErrors();

	if (!addModal.form.email.trim()) {
		addModal.errors.email = 'Email address is required';
		return false;
	}

	if (!isValidEmail(addModal.form.email.trim())) {
		addModal.errors.email = 'Please enter a valid email address';
		return false;
	}

	return true;
};

// Handle add blocked email
const handleAddBlockedEmail = async () => {
	if (!hasActiveOrganization.value) return;
	if (!validateAddForm()) return;

	addModal.isSubmitting.value = true;

	const result = await addBlockedEmail({
		email: normalizeEmail(addModal.form.email),
		reason: 'manual',
		notes: addModal.form.notes.trim() || undefined,
	});
	addModal.isSubmitting.value = false;

	if (result === undefined) return;

	showNotification('Address suppressed');
	addModal.close();
};

// Handle delete blocked email
const handleDeleteBlockedEmail = async () => {
	if (!emailToDelete.value) return;

	isDeleting.value = true;

	const result = await removeBlockedEmail({
		blockedEmailId: emailToDelete.value._id,
	});
	isDeleting.value = false;

	if (result === undefined) return;

	showNotification('Suppression removed');
	emailToDelete.value = null;
};

// The reason -> badge/icon/label decision lives in ONE place (see
// `~/utils/suppressionReasons`), shared with the contact-profile notice. The
// parameter is the closed `BlockReason` union, so the lookup is total: a fifth
// schema literal fails the build instead of silently rendering as "manual".
const presentation = (reason: BlockReason) => suppressionReasonPresentation(reason);

// The stat row, driven by the shared reason table rather than four hand-written
// cards. Typed as `BlockReason` so the icons and tones come from that same
// total lookup instead of a widened string.
const reasonTiles = computed<{ key: BlockReason; label: string; count: number }[]>(() => {
	const c = countsData.value;
	if (!c) return [];
	return [
		{ key: 'bounced', label: 'Bounced', count: c.bounced },
		{ key: 'complained', label: 'Complained', count: c.complained },
		{ key: 'manual', label: 'Manual', count: c.manual },
		{ key: 'unengaged', label: 'Unengaged', count: c.unengaged },
	];
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/audience"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Audience
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-semibold text-text-primary">Suppressions</h1>
					<p class="mt-1 text-text-secondary">
						Addresses that no longer receive mail — so a bounce or complaint never happens twice
					</p>
				</div>
				<div class="flex items-center gap-2">
					<UiButton variant="secondary" class="gap-2" @click="blocklistImport.open()">
						<Icon name="lucide:file-up" class="w-4 h-4" />
						Import
					</UiButton>
					<UiButton class="gap-2" @click="addModal.open()">
						<Icon name="lucide:plus" class="w-4 h-4" />
						Add suppression
					</UiButton>
				</div>
			</div>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !blockedEmailsData"
			:error="blockedEmailsError"
			error-title="Couldn't load suppressions"
			loading-label="Loading suppressions..."
		>
			<!-- No Organization State -->
			<div v-if="!hasActiveOrganization" class="card p-0 overflow-hidden">
				<UiEmptyState
					icon="lucide:ban"
					title="No workspace selected"
					description="Create or select a workspace to manage your suppressions."
				/>
			</div>

			<!-- Content -->
			<div v-else class="space-y-6">
				<!-- Auto-suppression paused on an uncorroborated clock. Self-contained:
				     renders nothing at all on a healthy deployment. -->
				<ContactsSunsetClockBanner />

				<!-- Info Card -->
				<div class="card p-6 bg-warning/5 border-warning/20">
					<div class="flex gap-4">
						<UiIconBox icon="lucide:alert-triangle" size="sm" variant="warning" rounded="lg" />
						<div>
							<h3 class="font-medium text-text-primary mb-1">What are suppressions?</h3>
							<p class="text-sm text-text-secondary">
								Suppressed addresses stop receiving mail from your campaigns and automations. An
								address is added automatically when it bounces (the mailbox doesn't exist) or when
								someone marks a send as spam — so you never send to it again. You can also suppress
								an address by hand to stop sending to a specific recipient.
							</p>
						</div>
					</div>
				</div>

				<!-- The sunset operator surface used to be API-only. Keeping it beside
				     suppressions gives every policy, stage, exemption and restore entry a
				     concrete owner-facing workflow. -->
				<div v-if="canManageSunset && sunsetPolicies" class="card p-6 space-y-6">
					<div>
						<h2 class="font-medium text-text-primary">Automatic list sunsetting</h2>
						<p class="mt-1 text-sm text-text-secondary">
							Move quiet contacts to re-engagement, then suppress them after a longer window.
						</p>
					</div>

					<div class="grid gap-4 md:grid-cols-[auto_1fr_1fr_auto] md:items-end">
						<label class="flex items-center gap-2 pb-2 text-sm text-text-secondary">
							<input v-model="sunsetPolicyForm.isEnabled" type="checkbox" />
							Enabled
						</label>
						<UiInput
							v-model.number="sunsetPolicyForm.reengageAfterDays"
							type="number"
							label="Re-engage after days"
							:min="30"
						/>
						<UiInput
							v-model.number="sunsetPolicyForm.suppressAfterDays"
							type="number"
							label="Suppress after days"
							:min="sunsetPolicyForm.reengageAfterDays"
						/>
						<UiButton :loading="isSavingSunsetPolicy" @click="saveSunsetPolicy">Save</UiButton>
					</div>

					<div class="grid gap-6 lg:grid-cols-2">
						<div>
							<h3 class="text-sm font-medium text-text-primary">Re-engagement track</h3>
							<p v-if="!reengagementContacts?.page.length" class="mt-2 text-sm text-text-tertiary">
								No contacts are currently on this track.
							</p>
							<ul v-else class="mt-2 divide-y divide-border-subtle">
								<li
									v-for="contact in reengagementContacts.page"
									:key="contact.contactId"
									class="flex items-center justify-between gap-3 py-2"
								>
									<span class="truncate text-sm text-text-secondary">{{
										contact.email ?? 'No email'
									}}</span>
									<UiButton
										variant="ghost"
										@click="toggleSunsetExemption(contact.contactId, !contact.isExempt)"
									>
										{{ contact.isExempt ? 'Remove exemption' : 'Exempt' }}
									</UiButton>
								</li>
							</ul>
						</div>

						<div>
							<h3 class="text-sm font-medium text-text-primary">Auto-suppressed contacts</h3>
							<p
								v-if="!sunsetSuppressedContacts?.page.length"
								class="mt-2 text-sm text-text-tertiary"
							>
								No contacts were auto-suppressed.
							</p>
							<ul v-else class="mt-2 divide-y divide-border-subtle">
								<li
									v-for="contact in sunsetSuppressedContacts.page"
									:key="contact.contactId"
									class="flex items-center justify-between gap-3 py-2"
								>
									<span class="truncate text-sm text-text-secondary">{{
										contact.email ?? 'No email'
									}}</span>
									<UiButton variant="ghost" @click="restoreSunset(contact.contactId)"
										>Restore</UiButton
									>
								</li>
							</ul>
						</div>
					</div>
				</div>

				<!-- Stats Cards -->
				<div v-if="countsData" class="grid grid-cols-2 md:grid-cols-5 gap-4">
					<div class="card p-4">
						<p class="text-sm text-text-secondary">Total suppressed</p>
						<p class="text-2xl font-semibold text-text-primary mt-1">{{ countsData.total }}</p>
					</div>
					<div v-for="tile in reasonTiles" :key="tile.key" class="card p-4">
						<div class="flex items-center gap-2">
							<Icon
								:name="presentation(tile.key).icon"
								class="w-4 h-4"
								:class="presentation(tile.key).tone"
							/>
							<p class="text-sm text-text-secondary">{{ tile.label }}</p>
						</div>
						<p class="text-2xl font-semibold text-text-primary mt-1">{{ tile.count }}</p>
					</div>
				</div>

				<!-- Filters and Search -->
				<div class="flex flex-col sm:flex-row gap-4">
					<!-- Search -->
					<div class="relative flex-1">
						<Icon
							name="lucide:search"
							class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
						/>
						<input
							v-model="searchQuery"
							type="text"
							placeholder="Search by email address..."
							class="input pl-10"
						/>
					</div>

					<!-- Filter by reason -->
					<div class="flex items-center gap-2">
						<Icon name="lucide:filter" class="w-4 h-4 text-text-tertiary" />
						<select v-model="reasonFilter" class="input w-40">
							<option value="all">All reasons</option>
							<option value="bounced">Bounced</option>
							<option value="complained">Complained</option>
							<option value="manual">Manually suppressed</option>
							<option value="unengaged">Unengaged</option>
						</select>
					</div>
				</div>

				<!-- Empty State -->
				<div
					v-if="blockedEmailsData && blockedEmailsData.length === 0"
					class="card p-0 overflow-hidden"
				>
					<UiEmptyState
						icon="lucide:ban"
						title="No suppressions"
						description="Nothing is suppressed. Addresses are added automatically when they bounce or when someone marks a send as spam."
					>
						<template #action>
							<UiButton @click="addModal.open()">
								<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
								Add suppression
							</UiButton>
						</template>
					</UiEmptyState>
				</div>

				<!-- No Search Results -->
				<div
					v-else-if="filteredBlockedEmails.length === 0 && searchQuery.trim()"
					class="card p-0 overflow-hidden"
				>
					<UiEmptyState
						icon="lucide:search"
						title="No results found"
						:description="`No suppressions match &quot;${searchQuery}&quot;. Try a different search term.`"
					/>
				</div>

				<!-- Blocked Emails List -->
				<div v-else-if="filteredBlockedEmails.length > 0" class="card p-0 overflow-hidden">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle bg-bg-surface/50">
								<th
									class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3"
								>
									Email Address
								</th>
								<th
									class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3"
								>
									Reason
								</th>
								<th
									class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3 hidden md:table-cell"
								>
									Notes
								</th>
								<th
									class="text-left text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3 hidden lg:table-cell"
								>
									Date Added
								</th>
								<th
									class="text-right text-xs font-medium text-text-tertiary uppercase tracking-wider px-6 py-3"
								>
									Actions
								</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border-subtle">
							<tr
								v-for="blockedEmail in filteredBlockedEmails"
								:key="blockedEmail._id"
								class="hover:bg-bg-surface/30 transition-colors"
							>
								<td class="px-6 py-4">
									<div class="flex items-center gap-3">
										<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
											<Icon
												:name="presentation(blockedEmail.reason).icon"
												class="w-4 h-4 text-text-secondary"
											/>
										</div>
										<span class="text-sm font-medium text-text-primary">
											{{ blockedEmail.email }}
										</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
											presentation(blockedEmail.reason).badge,
										]"
									>
										{{ presentation(blockedEmail.reason).label }}
									</span>
								</td>
								<td class="px-6 py-4 hidden md:table-cell">
									<span
										v-if="blockedEmail.notes"
										class="text-sm text-text-secondary truncate max-w-[200px] block"
									>
										{{ blockedEmail.notes }}
									</span>
									<span
										v-else-if="provenanceFor(blockedEmail._id)"
										class="text-sm text-text-secondary block"
										data-testid="suppression-provenance"
									>
										{{ provenanceFor(blockedEmail._id) }}
									</span>
									<span v-else class="text-sm text-text-tertiary">—</span>
								</td>
								<td class="px-6 py-4 hidden lg:table-cell">
									<span class="text-sm text-text-secondary">
										{{ formatDateTime(blockedEmail.createdAt) }}
									</span>
								</td>
								<td class="px-6 py-4 text-right">
									<UiButton
										variant="ghost"
										class="p-2 text-error hover:bg-error/10"
										title="Remove suppression"
										@click="emailToDelete = blockedEmail"
									>
										<Icon name="lucide:trash-2" class="w-4 h-4" />
									</UiButton>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</UiQueryBoundary>

		<!-- Add suppression Modal -->
		<UiModal v-model:open="addModal.isOpen.value" title="Add suppression">
			<form @submit.prevent="handleAddBlockedEmail">
				<div class="space-y-4">
					<!-- Email Input -->
					<UiInput
						v-model="addModal.form.email"
						type="email"
						label="Email Address"
						:required="true"
						placeholder="email@example.com"
						:error="addModal.errors.email"
						:disabled="addModal.isSubmitting.value"
					/>

					<!-- Notes Input -->
					<div>
						<label for="blocked-notes" class="label"> Notes (optional) </label>
						<textarea
							id="blocked-notes"
							v-model="addModal.form.notes"
							rows="3"
							placeholder="Why suppress this address?"
							class="input resize-none"
							:disabled="addModal.isSubmitting.value"
						/>
						<p class="mt-1 text-xs text-text-tertiary">
							Add a note to help you remember why this address was suppressed.
						</p>
					</div>
				</div>
			</form>

			<template #footer>
				<UiButton
					variant="secondary"
					:disabled="addModal.isSubmitting.value"
					@click="addModal.close()"
				>
					Cancel
				</UiButton>
				<UiButton :loading="addModal.isSubmitting.value" @click="handleAddBlockedEmail">
					<template #iconLeft>
						<Icon v-if="!addModal.isSubmitting.value" name="lucide:plus" class="w-4 h-4" />
					</template>
					{{ addModal.isSubmitting.value ? 'Adding...' : 'Add suppression' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiConfirmationDialog
			:open="!!emailToDelete"
			variant="danger"
			title="Remove suppression"
			:description="`Removing the suppression on &quot;${emailToDelete?.email ?? ''}&quot; lets them receive your mail again.`"
			confirm-text="Remove suppression"
			:is-loading="isDeleting"
			@update:open="
				(v: boolean) => {
					if (!v) emailToDelete = null;
				}
			"
			@confirm="handleDeleteBlockedEmail"
		/>

		<!-- Bulk Import Modal -->
		<AudienceSuppressionsImportModal
			:blocklist-import="blocklistImport"
			@import="handleImportBlocklist"
		/>
	</div>
</template>
