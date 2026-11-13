<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '@owlat/shared';
import type { BlockReason } from '~/utils/suppressionReasons';
import {
	CircleSlashIcon,
	FileUploadIcon,
	FilterIcon,
	ListFilterIcon,
	PlusIcon,
	SearchIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.suppressions.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();
// Adding, importing and removing need contacts:manage (the backend checks it
// too); everyone else reads the list.
const { canManageContacts } = usePermissions();

// Filter state
const reasonFilter = ref<'all' | BlockReason>('all');

// Get blocked emails with real-time updates
const {
	data: blockedEmailsData,
	isLoading: blockedEmailsLoading,
	error: blockedEmailsError,
	refetch: refetchBlockedEmails,
} = useOrganizationQuery(api.blockedEmails.blocklist.listByTeam, () => ({
	reason: reasonFilter.value === 'all' ? undefined : reasonFilter.value,
}));

// Get counts by reason
const { data: countsData } = useOrganizationQuery(api.blockedEmails.blocklist.getCountsByReason);

const isLoading = computed(() => organizationLoading.value || blockedEmailsLoading.value);

// Mutations
const { run: addBlockedEmail } = useBackendOperation(api.blockedEmails.blocklist.add, {
	label: () => t('dashboard.audience.suppressions.operations.add'),
});
const { run: removeBlockedEmail } = useBackendOperation(api.blockedEmails.blocklist.remove, {
	label: () => t('dashboard.audience.suppressions.operations.remove'),
});
const { run: bulkAddBlockedEmails } = useBackendOperation(api.blockedEmails.blocklist.bulkAdd, {
	label: () => t('dashboard.audience.suppressions.operations.import'),
});

// Bulk import from a CSV / text file → blockedEmails/blocklist.bulkAdd
const blocklistImport = useBlocklistImport();

const handleImportBlocklist = async () => {
	if (!hasActiveOrganization.value) return;

	const result = await blocklistImport.startImport((emails) => bulkAddBlockedEmails({ emails }));
	if (result === undefined) return;

	const { added, skipped } = result;
	showNotification(
		added > 0
			? skipped > 0
				? t('dashboard.audience.suppressions.toasts.imported', { count: added, skipped }, added)
				: t('dashboard.audience.suppressions.toasts.importedNoSkips', { count: added }, added)
			: t('dashboard.audience.suppressions.toasts.importedNone')
	);
};

// List FILTER — narrows the loaded suppressions in place. It is not the search
// box (that is the one ⌘K overlay), which is why it says "Filter…" and wears a
// filter icon. It ran undebounced, re-filtering the whole list on every
// keystroke; it now shares `useDebouncedSearch` with every other list filter.
const { searchQuery, debouncedSearch } = useDebouncedSearch();

const filteredBlockedEmails = computed(() => {
	if (!blockedEmailsData.value) return [];
	const query = debouncedSearch.value.toLowerCase().trim();
	if (!query) return blockedEmailsData.value;

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
		addModal.errors.email = t('dashboard.audience.suppressions.validation.emailRequired');
		return false;
	}

	if (!isValidEmail(addModal.form.email.trim())) {
		addModal.errors.email = t('auth.validation.emailInvalid');
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

	if (!result.ok) return;

	showNotification(t('dashboard.audience.suppressions.toasts.added'));
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

	if (!result.ok) return;

	showNotification(t('dashboard.audience.suppressions.toasts.removed'));
	emailToDelete.value = null;
};

// The per-reason counts ride on the reason filter's options, so the page leads
// with the list rather than a row of counters.
const reasonOptions = computed<{ value: 'all' | BlockReason; label: string }[]>(() => {
	const c = countsData.value;
	const withCount = (label: string, count: number | undefined) =>
		count === undefined ? label : `${label} (${count})`;
	return [
		{ value: 'all', label: withCount(t('dashboard.audience.suppressions.filters.all'), c?.total) },
		{
			value: 'bounced',
			label: withCount(t('dashboard.audience.suppressions.filters.bounced'), c?.bounced),
		},
		{
			value: 'complained',
			label: withCount(t('dashboard.audience.suppressions.filters.complained'), c?.complained),
		},
		{
			value: 'manual',
			label: withCount(t('dashboard.audience.suppressions.filters.manual'), c?.manual),
		},
		{
			value: 'unengaged',
			label: withCount(t('dashboard.audience.suppressions.filters.unengaged'), c?.unengaged),
		},
	];
});

const reasonFilterLabel = computed(() =>
	reasonFilter.value === 'all'
		? ''
		: t(`dashboard.audience.suppressions.filters.${reasonFilter.value}`)
);

const showInfo = ref(false);
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<!-- Header -->
		<AudienceTabs />
		<div class="mb-6">
			<UiPageHeader
				:title="t('dashboard.audience.suppressions.title')"
				:description="t('dashboard.audience.suppressions.subtitle')"
			>
				<template #actions>
					<p v-if="!canManageContacts" class="text-sm text-text-tertiary">
						{{ t('dashboard.audience.suppressions.readOnly') }}
					</p>
					<UiButton
						v-if="canManageContacts"
						variant="secondary"
						class="gap-2"
						@click="blocklistImport.open()"
					>
						<FileUploadIcon class="w-4 h-4" />
						{{ t('dashboard.audience.suppressions.import') }}
					</UiButton>
					<UiButton v-if="canManageContacts" class="gap-2" @click="addModal.open()">
						<PlusIcon class="w-4 h-4" />
						{{ t('dashboard.audience.suppressions.addSuppression') }}
					</UiButton>
				</template>
			</UiPageHeader>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !blockedEmailsData"
			:error="blockedEmailsError"
			@retry="refetchBlockedEmails"
			:error-title="t('dashboard.audience.suppressions.errorTitle')"
			:loading-label="t('dashboard.audience.suppressions.loading')"
		>
			<!-- No Organization State -->
			<div v-if="!hasActiveOrganization" class="card p-0 overflow-hidden">
				<UiEmptyState
					:icon="CircleSlashIcon"
					:title="t('dashboard.audience.suppressions.noWorkspace.title')"
					:description="t('dashboard.audience.suppressions.noWorkspace.description')"
				/>
			</div>

			<!-- Content -->
			<div v-else class="space-y-6">
				<!-- Auto-suppression paused on an uncorroborated clock. Self-contained:
				     renders nothing at all on a healthy deployment. -->
				<ContactsSunsetClockBanner />

				<!-- What suppressions are: help on request, not a standing banner. -->
				<UiDisclosure v-model="showInfo" :label="t('dashboard.audience.suppressions.info.title')">
					<p class="text-sm text-text-secondary max-w-prose">
						{{ t('dashboard.audience.suppressions.info.body') }}
					</p>
				</UiDisclosure>

				<!-- Filters and Search -->
				<div class="flex flex-col sm:flex-row gap-4">
					<!-- Filter (not search — see the composable comment above) -->
					<div class="relative flex-1">
						<ListFilterIcon
							class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
						/>
						<input
							v-model="searchQuery"
							type="text"
							:placeholder="t('common.filterPlaceholder')"
							:aria-label="t('dashboard.audience.suppressions.filterLabel')"
							class="input pl-10"
						/>
					</div>

					<!-- Filter by reason -->
					<div class="flex items-center gap-2">
						<FilterIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
						<select
							v-model="reasonFilter"
							class="input w-full sm:w-56"
							:aria-label="t('dashboard.audience.suppressions.table.reason')"
						>
							<option v-for="option in reasonOptions" :key="option.value" :value="option.value">
								{{ option.label }}
							</option>
						</select>
					</div>
				</div>

				<!-- No rows for the chosen reason: the list is not empty, the filter is. -->
				<div
					v-if="blockedEmailsData && blockedEmailsData.length === 0 && reasonFilter !== 'all'"
					class="card p-0 overflow-hidden"
				>
					<UiEmptyState
						variant="no-results"
						:icon="FilterIcon"
						:title="
							t('dashboard.audience.suppressions.noReasonResults.title', {
								reason: reasonFilterLabel,
							})
						"
						:clear-label="t('dashboard.audience.suppressions.noReasonResults.showAll')"
						@clear="reasonFilter = 'all'"
					/>
				</div>

				<!-- Empty State -->
				<div
					v-else-if="blockedEmailsData && blockedEmailsData.length === 0"
					class="card p-0 overflow-hidden"
				>
					<UiEmptyState
						:icon="CircleSlashIcon"
						:title="t('dashboard.audience.suppressions.empty.title')"
						:description="t('dashboard.audience.suppressions.empty.description')"
					>
						<template v-if="canManageContacts" #action>
							<UiButton @click="addModal.open()">
								<template #iconLeft><PlusIcon class="w-4 h-4" /></template>
								{{ t('dashboard.audience.suppressions.addSuppression') }}
							</UiButton>
						</template>
					</UiEmptyState>
				</div>

				<!-- No Search Results -->
				<div
					v-else-if="filteredBlockedEmails.length === 0 && debouncedSearch.trim()"
					class="card p-0 overflow-hidden"
				>
					<UiEmptyState
						:icon="SearchIcon"
						:title="t('dashboard.audience.suppressions.noResults.title')"
						:description="
							t('dashboard.audience.suppressions.noResults.description', { query: debouncedSearch })
						"
					/>
				</div>

				<!-- Blocked Emails List -->
				<div v-else-if="filteredBlockedEmails.length > 0" class="card p-0 overflow-hidden">
					<AudienceSuppressionsTable
						:rows="filteredBlockedEmails"
						:can-manage="canManageContacts"
						@remove="emailToDelete = $event"
					/>
				</div>

				<!-- Policy management comes after the list it acts on. -->
				<AudienceSuppressionSunsetControls />
			</div>
		</UiQueryBoundary>

		<!-- Add suppression Modal -->
		<UiModal
			v-model:open="addModal.isOpen.value"
			:title="t('dashboard.audience.suppressions.addSuppression')"
		>
			<form @submit.prevent="handleAddBlockedEmail">
				<div class="space-y-4">
					<!-- Email Input -->
					<UiInput
						v-model="addModal.form.email"
						type="email"
						:label="t('dashboard.audience.suppressions.form.emailLabel')"
						:required="true"
						:placeholder="t('dashboard.audience.suppressions.form.emailPlaceholder')"
						:error="addModal.errors.email"
						:disabled="addModal.isSubmitting.value"
					/>

					<!-- Notes Input -->
					<div>
						<label for="blocked-notes" class="label">{{
							t('dashboard.audience.suppressions.form.notesLabel')
						}}</label>
						<textarea
							id="blocked-notes"
							v-model="addModal.form.notes"
							rows="3"
							:placeholder="t('dashboard.audience.suppressions.form.notesPlaceholder')"
							class="input resize-none"
							:disabled="addModal.isSubmitting.value"
						/>
						<p class="mt-1 text-xs text-text-tertiary">
							{{ t('dashboard.audience.suppressions.form.notesHelp') }}
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
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton :loading="addModal.isSubmitting.value" @click="handleAddBlockedEmail">
					<template #iconLeft>
						<PlusIcon v-if="!addModal.isSubmitting.value" class="w-4 h-4" />
					</template>
					{{
						addModal.isSubmitting.value
							? t('dashboard.audience.suppressions.adding')
							: t('dashboard.audience.suppressions.addSuppression')
					}}
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete Confirmation Modal -->
		<UiConfirmationDialog
			:open="!!emailToDelete"
			variant="danger"
			:title="t('dashboard.audience.suppressions.removeSuppression')"
			:description="
				t('dashboard.audience.suppressions.removeDescription', {
					email: emailToDelete?.email ?? '',
				})
			"
			:confirm-text="t('dashboard.audience.suppressions.removeSuppression')"
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
