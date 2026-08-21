<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { isValidEmail, normalizeEmail } from '~/utils/validation';
import { type BlockReason, suppressionReasonPresentation } from '~/utils/suppressionReasons';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.suppressions.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

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

const isLoading = computed(() => organizationLoading.value || blockedEmailsLoading.value);

// Mutations
const { run: addBlockedEmail } = useBackendOperation(api.blockedEmails.add, {
	label: () => t('dashboard.audience.suppressions.operations.add'),
});
const { run: removeBlockedEmail } = useBackendOperation(api.blockedEmails.remove, {
	label: () => t('dashboard.audience.suppressions.operations.remove'),
});
const { run: bulkAddBlockedEmails } = useBackendOperation(api.blockedEmails.bulkAdd, {
	label: () => t('dashboard.audience.suppressions.operations.import'),
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
			? skipped > 0
				? t('dashboard.audience.suppressions.toasts.imported', { count: added, skipped }, added)
				: t('dashboard.audience.suppressions.toasts.importedNoSkips', { count: added }, added)
			: t('dashboard.audience.suppressions.toasts.importedNone')
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

	if (result === undefined) return;

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

	if (result === undefined) return;

	showNotification(t('dashboard.audience.suppressions.toasts.removed'));
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
		{ key: 'bounced', label: t('dashboard.audience.suppressions.tiles.bounced'), count: c.bounced },
		{
			key: 'complained',
			label: t('dashboard.audience.suppressions.tiles.complained'),
			count: c.complained,
		},
		{ key: 'manual', label: t('dashboard.audience.suppressions.tiles.manual'), count: c.manual },
		{
			key: 'unengaged',
			label: t('dashboard.audience.suppressions.tiles.unengaged'),
			count: c.unengaged,
		},
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
				{{ t('dashboard.audience.suppressions.backToAudience') }}
			</NuxtLink>
			<div class="flex items-center justify-between">
				<div>
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						{{ t('dashboard.audience.suppressions.title') }}
					</h1>
					<p class="mt-1 text-text-secondary">
						{{ t('dashboard.audience.suppressions.subtitle') }}
					</p>
				</div>
				<div class="flex items-center gap-2">
					<UiButton variant="secondary" class="gap-2" @click="blocklistImport.open()">
						<Icon name="lucide:file-up" class="w-4 h-4" />
						{{ t('dashboard.audience.suppressions.import') }}
					</UiButton>
					<UiButton class="gap-2" @click="addModal.open()">
						<Icon name="lucide:plus" class="w-4 h-4" />
						{{ t('dashboard.audience.suppressions.addSuppression') }}
					</UiButton>
				</div>
			</div>
		</div>

		<UiQueryBoundary
			:loading="isLoading && !blockedEmailsData"
			:error="blockedEmailsError"
			:error-title="t('dashboard.audience.suppressions.errorTitle')"
			:loading-label="t('dashboard.audience.suppressions.loading')"
		>
			<!-- No Organization State -->
			<div v-if="!hasActiveOrganization" class="card p-0 overflow-hidden">
				<UiEmptyState
					icon="lucide:ban"
					:title="t('dashboard.audience.suppressions.noWorkspace.title')"
					:description="t('dashboard.audience.suppressions.noWorkspace.description')"
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
							<h3 class="font-medium text-text-primary mb-1">
								{{ t('dashboard.audience.suppressions.info.title') }}
							</h3>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.audience.suppressions.info.body') }}
							</p>
						</div>
					</div>
				</div>

				<SuppressionSunsetControls />

				<!-- Stats Cards -->
				<div v-if="countsData" class="grid grid-cols-2 md:grid-cols-5 gap-4">
					<div class="card p-4">
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.audience.suppressions.tiles.total') }}
						</p>
						<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
							{{ countsData.total }}
						</p>
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
						<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
							{{ tile.count }}
						</p>
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
							:placeholder="t('dashboard.audience.suppressions.searchPlaceholder')"
							class="input pl-10"
						/>
					</div>

					<!-- Filter by reason -->
					<div class="flex items-center gap-2">
						<Icon name="lucide:filter" class="w-4 h-4 text-text-tertiary" />
						<select v-model="reasonFilter" class="input w-40">
							<option value="all">{{ t('dashboard.audience.suppressions.filters.all') }}</option>
							<option value="bounced">
								{{ t('dashboard.audience.suppressions.filters.bounced') }}
							</option>
							<option value="complained">
								{{ t('dashboard.audience.suppressions.filters.complained') }}
							</option>
							<option value="manual">
								{{ t('dashboard.audience.suppressions.filters.manual') }}
							</option>
							<option value="unengaged">
								{{ t('dashboard.audience.suppressions.filters.unengaged') }}
							</option>
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
						:title="t('dashboard.audience.suppressions.empty.title')"
						:description="t('dashboard.audience.suppressions.empty.description')"
					>
						<template #action>
							<UiButton @click="addModal.open()">
								<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
								{{ t('dashboard.audience.suppressions.addSuppression') }}
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
						:title="t('dashboard.audience.suppressions.noResults.title')"
						:description="
							t('dashboard.audience.suppressions.noResults.description', { query: searchQuery })
						"
					/>
				</div>

				<!-- Blocked Emails List -->
				<div v-else-if="filteredBlockedEmails.length > 0" class="card p-0 overflow-hidden">
					<AudienceSuppressionsTable
						:rows="filteredBlockedEmails"
						@remove="emailToDelete = $event"
					/>
				</div>
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
						<Icon v-if="!addModal.isSubmitting.value" name="lucide:plus" class="w-4 h-4" />
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
