<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { tabPanelAttrs } from '@owlat/ui/utils/tabs';
import { formatContactPropertyValue } from '~/utils/contactPropertyValue';
import { formatDate } from '~/utils/formatters';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import { useContactTopics } from '~/composables/contacts/useContactTopics';
import ContactActivityLogCard from '~/components/contacts/detail/ActivityLogCard.vue';
import ContactCustomPropertiesCard from '~/components/contacts/detail/CustomPropertiesCard.vue';
import ContactDeleteDialog from '~/components/contacts/detail/DeleteContactDialog.vue';
import ContactDetailHeader from '~/components/contacts/detail/Header.vue';
import ContactProfileCard from '~/components/contacts/detail/ProfileCard.vue';
import ContactTopicsCard from '~/components/contacts/detail/TopicsCard.vue';
import { ArrowLeftIcon, CalendarIcon, CircleWarningIcon } from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.contacts.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get contact ID from route
const contactId = useRouteId<'contacts'>();

// GDPR data-subject access export: fetch the full personal-data bundle on
// demand and download it as JSON. An action, not a query: a Team Inbox body too
// large for its row lives in storage, which only an action can read.
const exportRequested = ref(false);
async function handleExportData() {
	if (exportRequested.value) return;
	exportRequested.value = true;
	try {
		const data = await requireConvex().action(api.contacts.dataExport.exportContactDataBundle, {
			contactId: contactId.value,
		});
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `contact-${contactId.value}-data-export.json`;
		a.click();
		URL.revokeObjectURL(url);
	} catch {
		showToast(t('dashboard.audience.contacts.detail.toasts.exportFailed'), 'error');
	} finally {
		exportRequested.value = false;
	}
}

// Resend the double-opt-in confirmation email for a contact stuck in `pending`.
async function handleResendDoi() {
	const result = await resendDoiConfirmation();
	if (result === undefined) return;
	if (result.success) {
		showToast(t('dashboard.audience.contacts.detail.toasts.doiSent'));
	} else {
		showToast(t('dashboard.audience.contacts.detail.toasts.doiFailed'), 'error');
	}
}

// Contact Detail (form state, save/cancel, display helpers)
const {
	contact,
	contactLoading,
	contactError,
	refetchContact,
	properties,
	isEditing,
	isSaving,
	isDeleting,
	showDeleteConfirm,
	saveError,
	editForm,
	propertyForm,
	commonTimezones,
	commonLanguages,
	startEditing,
	cancelEditing,
	saveChanges,
	confirmDelete,
	resendDoiConfirmation,
	isResendingDoi,
	getTimezoneLabel,
	getLanguageLabel,
	getPropertyValue,
	getDoiStatusLabel,
	getDoiStatusColor,
	getDoiStatusIcon,
} = useContactDetail(contactId);

/** A nameless contact is titled by the only thing it does have: its address. */
const contactTitle = computed(() => {
	const c = contact.value;
	if (!c) return '';
	const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
	return name || c.email || '';
});
// ⌘K's "Jump back" list remembers the contact once it has loaded.
useRecordPaletteObjectOpen(() =>
	contactTitle.value ? { kind: 'contact', id: contactId.value, title: contactTitle.value } : null
);

// Stored values are strings whatever the type: show Yes/No and a dated value
// in the reader's locale instead of `true` and `2026-11-09`.
const displayPropertyValue = (property: { _id: Id<'contactProperties'>; type: string }) =>
	formatContactPropertyValue(property.type, getPropertyValue(property._id), {
		yes: t('common.yes'),
		no: t('common.no'),
		date: (value) => formatDate(value, 'medium'),
	});

const { canManageContacts, canAnnotateContacts, isAdmin } = usePermissions();

// Members get a quiet two-tab profile. Admin-only CRM depth stays available
// without leaking its affordances into the everyday customer view.
const activeTab = ref('profile');
const tabPanelId = useId();
const tabOptions = computed(() =>
	isAdmin.value
		? [
				{ value: 'profile', label: t('dashboard.audience.contacts.detail.tabs.profile') },
				{ value: 'timeline', label: t('dashboard.audience.contacts.detail.tabs.timeline') },
				{ value: 'knowledge', label: t('dashboard.audience.contacts.detail.tabs.knowledge') },
				{ value: 'files', label: t('dashboard.audience.contacts.detail.tabs.files') },
				{ value: 'identities', label: t('dashboard.audience.contacts.detail.tabs.identities') },
				{
					value: 'relationships',
					label: t('dashboard.audience.contacts.detail.tabs.relationships'),
				},
			]
		: [
				{ value: 'profile', label: t('dashboard.audience.contacts.detail.tabs.profile') },
				{ value: 'timeline', label: t('dashboard.audience.contacts.detail.tabs.timeline') },
			]
);

// One Timeline tab: the messages, then (for admins) the activity log under
// them. 'profile' is the default tab, so the activity subscription is gated on
// the timeline actually being open. Without the gate every contact page paid
// for a listByContact subscription that members can never surface and admins
// usually don't open.
const isActivityTabActive = computed(() => isAdmin.value && activeTab.value === 'timeline');
const activityTimeline = useActivityTimeline(contactId, () => isActivityTabActive.value);

const notesDraft = ref('');
watch(
	contact,
	(value) => {
		notesDraft.value = value?.notes ?? '';
	},
	{ immediate: true }
);
const { run: updateNotes, isLoading: isSavingNotes } = useBackendOperation(
	api.contacts.contacts.updateNotes,
	{ label: () => t('dashboard.audience.contacts.detail.operations.saveNote') }
);
async function saveNotes() {
	const result = await updateNotes({ contactId: contactId.value, notes: notesDraft.value });
	if (result.ok) showToast(t('dashboard.audience.contacts.detail.toasts.noteSaved'));
}

// Topics
const {
	contactTopics,
	allTopics,
	isAddToTopicDropdownOpen,
	isAddingToTopic,
	availableTopicsToAdd,
	handleAddToTopic,
	handleRemoveFromTopic,
} = useContactTopics(contactId);

// Toast notifications (global)
const { showToast } = useToast();

// Suppression state — inline answer to "why isn't this contact getting mail?".
// The address is on the suppression list (blockedEmails) when getByEmail returns
// a record. Removal is permission-gated in the UI (contacts:manage) and
// re-checked on the backend.
const { data: suppression } = useConvexQuery(api.blockedEmails.blocklist.getByEmail, () =>
	contact.value?.email ? { email: contact.value.email } : 'skip'
);
const { run: removeSuppression, isLoading: isRemovingSuppression } = useBackendOperation(
	api.blockedEmails.blocklist.remove,
	{ label: () => t('dashboard.audience.contacts.detail.operations.removeSuppression') }
);
async function handleRemoveSuppression() {
	if (!suppression.value) return;
	const result = await removeSuppression({ blockedEmailId: suppression.value._id });
	if (!result.ok) return;
	showToast(t('dashboard.audience.contacts.detail.toasts.suppressionRemoved'));
}
</script>

<template>
	<div class="mx-auto w-full max-w-page p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/audience/contacts"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<ArrowLeftIcon class="w-4 h-4" />
			{{ t('dashboard.audience.contacts.detail.backToCustomers') }}
		</NuxtLink>

		<!-- A failed read is not a missing contact. -->
		<UiQueryBoundary v-if="contactError" :error="contactError" @retry="refetchContact" />

		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-else-if="contactLoading && !contact"
			:label="t('dashboard.audience.contacts.detail.loading')"
			lead="avatar"
			meta
			:actions="2"
			tabs
		/>

		<!-- Not Found State -->
		<div
			v-else-if="!contactLoading && !contact"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox
				:icon="CircleWarningIcon"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4"
			/>
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.audience.contacts.detail.notFound.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('dashboard.audience.contacts.detail.notFound.body') }}
			</p>
			<UiButton variant="secondary" to="/dashboard/audience/contacts" class="mt-6">
				{{ t('dashboard.audience.contacts.detail.notFound.action') }}
			</UiButton>
		</div>

		<!-- Contact Content -->
		<template v-else-if="contact">
			<!-- Suppression notice — inline answer to "why no mail?" -->
			<ContactsSuppressionNotice
				v-if="suppression"
				:reason="suppression.reason"
				:date-label="formatShortDate(suppression.createdAt)"
				:can-manage="canManageContacts"
				:removing="isRemovingSuppression"
				class="mb-6"
				@remove="handleRemoveSuppression"
			/>

			<!-- Header -->
			<ContactDetailHeader
				:title="contactTitle"
				:email="contact.email"
				:doi-status="contact.doiStatus"
				:doi-label="getDoiStatusLabel(contact.doiStatus)"
				:doi-color="getDoiStatusColor(contact.doiStatus)"
				:doi-icon="getDoiStatusIcon(contact.doiStatus)"
				:is-editing="isEditing"
				:is-saving="isSaving"
				:can-manage="canManageContacts"
				:is-resending-doi="isResendingDoi"
				:exporting="exportRequested"
				@cancel="cancelEditing"
				@save="saveChanges"
				@edit="startEditing"
				@resend-doi="handleResendDoi"
				@export="handleExportData"
				@delete="showDeleteConfirm = true"
			/>

			<!-- Error Message -->
			<div
				v-if="saveError"
				class="mb-6 p-4 rounded-lg bg-error-subtle border border-error/20 text-error flex items-center gap-3"
			>
				<CircleWarningIcon class="w-5 h-5 flex-shrink-0" />
				{{ saveError }}
			</div>

			<div class="mb-6">
				<UiTabs v-model="activeTab" :tabs="tabOptions" :panel-id="tabPanelId" />
			</div>

			<div
				v-bind="tabPanelAttrs(tabPanelId, tabOptions, activeTab)"
				class="grid grid-cols-1 lg:grid-cols-3 gap-6"
			>
				<!-- Main Info -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Contact Details Card -->
					<ContactProfileCard
						v-if="isAdmin || activeTab === 'profile'"
						:contact="contact"
						:is-editing="isEditing"
						:form="editForm"
						:timezones="commonTimezones"
						:languages="commonLanguages"
						:timezone-label="getTimezoneLabel(contact.timezone)"
						:language-label="getLanguageLabel(contact.language)"
					/>

					<!-- Custom Properties Card -->
					<ContactCustomPropertiesCard
						v-if="isAdmin && properties && properties.length > 0"
						:properties="properties"
						:is-editing="isEditing"
						:form="propertyForm"
						:display-value="displayPropertyValue"
					/>

					<div v-if="(isAdmin || activeTab === 'profile') && canAnnotateContacts" class="card">
						<div class="flex items-start justify-between gap-4 mb-3">
							<div>
								<h2 class="text-lg font-medium text-text-primary">
									{{ t('dashboard.audience.contacts.detail.teamNote.title') }}
								</h2>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.audience.contacts.detail.teamNote.subtitle') }}
								</p>
							</div>
							<UiButton
								size="sm"
								class="shrink-0 whitespace-nowrap"
								:loading="isSavingNotes"
								@click="saveNotes"
								>{{ t('dashboard.audience.contacts.detail.teamNote.save') }}</UiButton
							>
						</div>
						<UiTextarea
							v-model="notesDraft"
							:rows="4"
							:placeholder="t('dashboard.audience.contacts.detail.teamNote.placeholder')"
						/>
					</div>

					<!-- Timeline Tab: messages across channels, then the activity log -->
					<ContactsUnifiedTimelineTab v-if="activeTab === 'timeline'" :contact-id="contactId" />
					<ContactActivityLogCard
						v-if="isAdmin && activeTab === 'timeline'"
						:timeline="activityTimeline"
					/>

					<!-- Knowledge Tab -->
					<ContactsContactKnowledgeTab
						v-if="isAdmin && activeTab === 'knowledge'"
						:contact-id="contactId"
					/>

					<!-- Files Tab -->
					<ContactsContactFilesTab
						v-if="isAdmin && activeTab === 'files'"
						:contact-id="contactId"
					/>

					<!-- Identities Tab -->
					<ContactsIdentitiesTab
						v-if="isAdmin && activeTab === 'identities'"
						:contact-id="contactId"
						@toast="showToast"
					/>

					<!-- Relationships Tab -->
					<ContactsRelationshipsTab
						v-if="isAdmin && activeTab === 'relationships'"
						:contact-id="contactId"
						@toast="showToast"
					/>
				</div>

				<!-- Sidebar -->
				<div v-if="isAdmin || activeTab === 'profile'" class="space-y-6">
					<!-- Communication Stats Card -->
					<ContactsTimelineStatsCard :contact-id="contactId" />

					<!-- Metadata Card -->
					<div v-if="isAdmin" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.audience.contacts.detail.details') }}
						</h2>

						<div class="space-y-4">
							<div>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.audience.contacts.detail.source') }}
								</p>
								<p class="text-text-primary capitalize">
									{{ contact.source || t('common.unknown') }}
								</p>
							</div>

							<div>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.audience.contacts.detail.created') }}
								</p>
								<div class="flex items-center gap-2 text-text-primary">
									<CalendarIcon class="w-4 h-4 text-text-tertiary" />
									{{ formatDateTime(contact.createdAt) }}
								</div>
							</div>

							<div>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.audience.contacts.detail.lastUpdated') }}
								</p>
								<div class="flex items-center gap-2 text-text-primary">
									<CalendarIcon class="w-4 h-4 text-text-tertiary" />
									{{ formatDateTime(contact.updatedAt) }}
								</div>
							</div>
						</div>
					</div>

					<!-- Topics Card -->
					<ContactTopicsCard
						v-if="isAdmin"
						v-model:open="isAddToTopicDropdownOpen"
						:contact-topics="contactTopics"
						:all-topics="allTopics"
						:available-topics="availableTopicsToAdd"
						:is-adding="isAddingToTopic"
						@add="handleAddToTopic"
						@remove="handleRemoveFromTopic"
					/>
				</div>
			</div>
		</template>

		<!-- Delete Confirmation Modal -->
		<ContactDeleteDialog
			v-model:open="showDeleteConfirm"
			:email="contact?.email"
			:is-deleting="isDeleting"
			@confirm="confirmDelete"
		/>
	</div>
</template>
