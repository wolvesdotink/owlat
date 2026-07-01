<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';

useHead({ title: 'Blocklist — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// Filter state
const reasonFilter = ref<'all' | 'bounced' | 'complained' | 'manual'>('all');

// Get blocked emails with real-time updates
const { data: blockedEmailsData, isLoading: blockedEmailsLoading } = useOrganizationQuery(
	api.blockedEmails.listByTeam,
	() => ({
		reason: reasonFilter.value === 'all' ? undefined : reasonFilter.value,
	})
);

// Get counts by reason
const { data: countsData } = useOrganizationQuery(api.blockedEmails.getCountsByReason);

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
			: 'No new addresses added — all were already blocked or invalid'
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

	showNotification('Email address added to blocklist');
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

	showNotification('Email address removed from blocklist');
	emailToDelete.value = null;
};

// Get reason badge class
const getReasonBadgeClass = (reason: string) => {
	switch (reason) {
		case 'bounced':
			return 'bg-error/20 text-error border-error/30';
		case 'complained':
			return 'bg-warning/20 text-warning border-warning/30';
		default: // manual
			return 'bg-brand/20 text-brand border-brand/30';
	}
};

// Get reason icon
const getReasonIcon = (reason: string) => {
	switch (reason) {
		case 'bounced':
			return 'lucide:mail';
		case 'complained':
			return 'lucide:message-square-warning';
		default: // manual
			return 'lucide:user-x';
	}
};

// Get reason label
const getReasonLabel = (reason: string) => {
	switch (reason) {
		case 'bounced':
			return 'Hard Bounce';
		case 'complained':
			return 'Spam Complaint';
		default: // manual
			return 'Manual';
	}
};

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
					<h1 class="text-2xl font-semibold text-text-primary">Email Blocklist</h1>
					<p class="mt-1 text-text-secondary">
						Manage blocked email addresses to protect your sender reputation
					</p>
				</div>
				<div class="flex items-center gap-2">
					<button class="btn btn-secondary gap-2" @click="blocklistImport.open()">
						<Icon name="lucide:file-up" class="w-4 h-4" />
						Import
					</button>
					<button class="btn btn-primary gap-2" @click="addModal.open()">
						<Icon name="lucide:plus" class="w-4 h-4" />
						Add to Blocklist
					</button>
				</div>
			</div>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading && !blockedEmailsData" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading blocklist...</p>
			</div>
		</div>

		<!-- No Organization State -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:ban" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No organization selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select an organization to manage your email blocklist.
			</p>
		</div>

		<!-- Content -->
		<div v-else class="space-y-6">
			<!-- Info Card -->
			<div class="card p-6 bg-warning/5 border-warning/20">
				<div class="flex gap-4">
					<UiIconBox icon="lucide:alert-triangle" size="sm" variant="warning" rounded="lg" />
					<div>
						<h3 class="font-medium text-text-primary mb-1">What is the blocklist?</h3>
						<p class="text-sm text-text-secondary">
							Blocked email addresses will not receive any emails from your campaigns or
							automations. Emails are automatically added when they hard bounce or when recipients
							mark your emails as spam. You can also manually add addresses to prevent sending to
							specific recipients.
						</p>
					</div>
				</div>
			</div>

			<!-- Stats Cards -->
			<div v-if="countsData" class="grid grid-cols-2 md:grid-cols-4 gap-4">
				<div class="card p-4">
					<p class="text-sm text-text-secondary">Total Blocked</p>
					<p class="text-2xl font-semibold text-text-primary mt-1">{{ countsData.total }}</p>
				</div>
				<div class="card p-4">
					<div class="flex items-center gap-2">
						<Icon name="lucide:mail" class="w-4 h-4 text-error" />
						<p class="text-sm text-text-secondary">Bounced</p>
					</div>
					<p class="text-2xl font-semibold text-text-primary mt-1">{{ countsData.bounced }}</p>
				</div>
				<div class="card p-4">
					<div class="flex items-center gap-2">
						<Icon name="lucide:message-square-warning" class="w-4 h-4 text-warning" />
						<p class="text-sm text-text-secondary">Spam Complaints</p>
					</div>
					<p class="text-2xl font-semibold text-text-primary mt-1">{{ countsData.complained }}</p>
				</div>
				<div class="card p-4">
					<div class="flex items-center gap-2">
						<Icon name="lucide:user-x" class="w-4 h-4 text-brand" />
						<p class="text-sm text-text-secondary">Manual</p>
					</div>
					<p class="text-2xl font-semibold text-text-primary mt-1">{{ countsData.manual }}</p>
				</div>
			</div>

			<!-- Filters and Search -->
			<div class="flex flex-col sm:flex-row gap-4">
				<!-- Search -->
				<div class="relative flex-1">
					<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
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
						<option value="all">All Reasons</option>
						<option value="bounced">Bounced</option>
						<option value="complained">Spam Complaints</option>
						<option value="manual">Manual</option>
					</select>
				</div>
			</div>

			<!-- Empty State -->
			<div
				v-if="blockedEmailsData && blockedEmailsData.length === 0"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:ban" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No blocked emails</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Your blocklist is empty. Emails will be added automatically when they bounce or when
					recipients report spam.
				</p>
				<button class="btn btn-primary gap-2 mt-4" @click="addModal.open()">
					<Icon name="lucide:plus" class="w-4 h-4" />
					Add Email Manually
				</button>
			</div>

			<!-- No Search Results -->
			<div
				v-else-if="filteredBlockedEmails.length === 0 && searchQuery.trim()"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
				<p class="text-text-secondary font-medium">No results found</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					No blocked emails match "{{ searchQuery }}". Try a different search term.
				</p>
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
											:name="getReasonIcon(blockedEmail.reason)"
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
										getReasonBadgeClass(blockedEmail.reason),
									]"
								>
									{{ getReasonLabel(blockedEmail.reason) }}
								</span>
							</td>
							<td class="px-6 py-4 hidden md:table-cell">
								<span
									v-if="blockedEmail.notes"
									class="text-sm text-text-secondary truncate max-w-[200px] block"
								>
									{{ blockedEmail.notes }}
								</span>
								<span v-else class="text-sm text-text-tertiary">—</span>
							</td>
							<td class="px-6 py-4 hidden lg:table-cell">
								<span class="text-sm text-text-secondary">
									{{ formatDateTime(blockedEmail.createdAt) }}
								</span>
							</td>
							<td class="px-6 py-4 text-right">
								<button
									class="btn btn-ghost p-2 text-error hover:bg-error/10"
									title="Remove from blocklist"
									@click="emailToDelete = blockedEmail"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>

		<!-- Add to Blocklist Modal -->
		<UiModal v-model:open="addModal.isOpen.value" title="Add to Blocklist">
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
							placeholder="Why is this email being blocked?"
							class="input resize-none"
							:disabled="addModal.isSubmitting.value"
						/>
						<p class="mt-1 text-xs text-text-tertiary">
							Add a note to help you remember why this email was blocked.
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
					{{ addModal.isSubmitting.value ? 'Adding...' : 'Add to Blocklist' }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiConfirmationDialog
			:open="!!emailToDelete"
			variant="danger"
			title="Remove from Blocklist"
			:description="`Removing &quot;${emailToDelete?.email ?? ''}&quot; from the blocklist will allow them to receive your emails again.`"
			confirm-text="Remove from Blocklist"
			:is-loading="isDeleting"
			@update:open="(v: boolean) => { if (!v) emailToDelete = null; }"
			@confirm="handleDeleteBlockedEmail"
		/>

		<!-- Bulk Import Modal -->
		<SettingsBlocklistImportModal
			:blocklist-import="blocklistImport"
			@import="handleImportBlocklist"
		/>
	</div>
</template>
