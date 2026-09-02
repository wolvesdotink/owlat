<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.contacts.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Get contact ID from route
const contactId = useRouteId<'contacts'>();

// GDPR data-subject access export: lazily fetch the full personal-data bundle
// on demand and download it as JSON. The query is skipped until requested.
const exportRequested = ref(false);
const { data: exportData } = useConvexQuery(api.contacts.dataExport.exportContactData, () =>
	exportRequested.value ? { contactId: contactId.value } : 'skip'
);
watch(exportData, (data) => {
	if (!data || !exportRequested.value || !import.meta.client) return;
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `contact-${contactId.value}-data-export.json`;
	a.click();
	URL.revokeObjectURL(url);
	exportRequested.value = false;
});
function handleExportData() {
	exportRequested.value = true;
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

const { canManageContacts, canAnnotateContacts, isAdmin } = usePermissions();

// Members get a quiet two-tab profile. Admin-only CRM depth stays available
// without leaking its affordances into the everyday customer view.
const activeTab = ref('profile');
const tabOptions = computed(() =>
	isAdmin.value
		? [
				{ value: 'profile', label: t('dashboard.audience.contacts.detail.tabs.profile') },
				{ value: 'activity', label: t('dashboard.audience.contacts.detail.tabs.activity') },
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
				{ value: 'timeline', label: t('dashboard.audience.contacts.detail.tabs.activity') },
			]
);

// Activity Timeline — the Activity tab is admin-only and 'profile' is the default
// tab, so the subscription is gated on the tab actually being open. Without the
// gate every contact page paid for a listByContact subscription that members can
// never surface and admins usually don't open.
const isActivityTabActive = computed(() => isAdmin.value && activeTab.value === 'activity');
const {
	accumulatedActivities,
	activitiesLoading,
	hasMoreActivities,
	isLoadingMoreActivities,
	loadMoreActivities,
	getActivityIcon,
	getActivityLabel,
	getActivityColor,
	getActivityDescription,
	formatActivityTime,
} = useActivityTimeline(contactId, () => isActivityTabActive.value);

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
const { data: contactTopics } = useConvexQuery(api.topics.topics.getTopicsForContact, () => ({
	contactId: contactId.value,
}));

const { results: allTopics } = useTopicsList();

const { run: addToTopic } = useBackendOperation(api.topics.topics.addContact, {
	label: () => t('dashboard.audience.contacts.detail.operations.addToTopic'),
});
const { run: removeFromTopic } = useBackendOperation(api.topics.topics.removeContact, {
	label: () => t('dashboard.audience.contacts.detail.operations.removeFromTopic'),
});

// Add to Topic Dropdown State
const isAddToTopicDropdownOpen = ref(false);
const isAddingToTopic = ref(false);

const availableTopicsToAdd = computed(() => {
	if (!allTopics.value || !contactTopics.value) return [];
	const currentTopicIds = new Set(contactTopics.value.map((t) => t._id));
	return allTopics.value.filter((topic) => !currentTopicIds.has(topic._id));
});

const handleAddToTopic = async (topicId: Id<'topics'>) => {
	isAddingToTopic.value = true;

	const result = await addToTopic({
		topicId,
		contactId: contactId.value,
	});
	isAddingToTopic.value = false;
	if (!result.ok) return;
	const topicName =
		allTopics.value?.find((topic) => topic._id === topicId)?.name ||
		t('dashboard.audience.contacts.detail.topicFallback');
	showToast(t('dashboard.audience.contacts.detail.toasts.addedToTopic', { topic: topicName }));
	isAddToTopicDropdownOpen.value = false;
};

const handleRemoveFromTopic = async (topicId: Id<'topics'>) => {
	const result = await removeFromTopic({
		topicId,
		contactId: contactId.value,
	});
	if (!result.ok) return;
	const topicName =
		contactTopics.value?.find((topic) => topic._id === topicId)?.name ||
		t('dashboard.audience.contacts.detail.topicFallback');
	showToast(t('dashboard.audience.contacts.detail.toasts.removedFromTopic', { topic: topicName }));
};

// Close dropdown when clicking outside
const addToTopicDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(addToTopicDropdownRef, () => {
	isAddToTopicDropdownOpen.value = false;
});

// Toast notifications (global)
const { showToast } = useToast();

// Suppression state — inline answer to "why isn't this contact getting mail?".
// The address is on the suppression list (blockedEmails) when getByEmail returns
// a record. Removal is permission-gated in the UI (contacts:manage) and
// re-checked on the backend.
const { data: suppression } = useConvexQuery(api.blockedEmails.getByEmail, () =>
	contact.value?.email ? { email: contact.value.email } : 'skip'
);
const { run: removeSuppression, isLoading: isRemovingSuppression } = useBackendOperation(
	api.blockedEmails.remove,
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
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/audience/contacts"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			{{ t('dashboard.audience.contacts.detail.backToCustomers') }}
		</NuxtLink>

		<!-- Loading State -->
		<div v-if="contactLoading && !contact" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.audience.contacts.detail.loading') }}
				</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div
			v-else-if="!contactLoading && !contact"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox
				icon="lucide:alert-circle"
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
			<div class="flex items-start gap-4 mb-8">
				<UiIconBox icon="lucide:user" size="xl" variant="surface" rounded="full" />
				<UiPageHeader class="flex-1" :title="contactTitle" :description="contact.email">
					<!-- Double-opt-in confirmation status -->
					<template v-if="getDoiStatusLabel(contact.doiStatus)" #meta>
						<div
							class="inline-flex items-center gap-1.5 text-sm"
							:class="getDoiStatusColor(contact.doiStatus)"
						>
							<Icon
								v-if="getDoiStatusIcon(contact.doiStatus)"
								:name="getDoiStatusIcon(contact.doiStatus)!"
								class="w-4 h-4"
							/>
							<span>{{
								t('dashboard.audience.contacts.detail.doiStatus', {
									status: getDoiStatusLabel(contact.doiStatus),
								})
							}}</span>
						</div>
					</template>

					<template #actions>
						<template v-if="isEditing">
							<UiButton variant="ghost" :disabled="isSaving" @click="cancelEditing">
								{{ t('common.cancel') }}
							</UiButton>
							<UiButton class="gap-2" :disabled="isSaving" @click="saveChanges">
								<UiSpinner v-if="isSaving" size="xs" tone="inverse" />
								<Icon v-else name="lucide:save" class="w-4 h-4" />
								{{ t('dashboard.audience.contacts.detail.saveChanges') }}
							</UiButton>
						</template>
						<template v-else-if="canManageContacts">
							<UiButton
								variant="secondary"
								v-if="contact.doiStatus === 'pending'"
								class="gap-2"
								:disabled="isResendingDoi"
								:title="t('dashboard.audience.contacts.detail.resendDoiTitle')"
								@click="handleResendDoi"
							>
								<Icon v-if="isResendingDoi" name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
								<Icon v-else name="lucide:mail-check" class="w-4 h-4" />
								{{
									isResendingDoi
										? t('dashboard.audience.contacts.detail.sending')
										: t('dashboard.audience.contacts.detail.resendDoi')
								}}
							</UiButton>
							<UiButton variant="secondary" class="gap-2" @click="startEditing">
								<Icon name="lucide:pencil" class="w-4 h-4" />
								{{ t('common.edit') }}
							</UiButton>
							<UiButton
								variant="secondary"
								class="gap-2"
								:disabled="exportRequested"
								:title="t('dashboard.audience.contacts.detail.exportDataTitle')"
								@click="handleExportData"
							>
								<Icon name="lucide:download" class="w-4 h-4" />
								{{
									exportRequested
										? t('dashboard.audience.contacts.detail.exporting')
										: t('dashboard.audience.contacts.detail.exportData')
								}}
							</UiButton>
							<UiButton
								variant="ghost"
								class="text-error hover:bg-error-subtle"
								@click="showDeleteConfirm = true"
								:aria-label="t('common.delete')"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</UiButton>
						</template>
					</template>
				</UiPageHeader>
			</div>

			<!-- Error Message -->
			<div
				v-if="saveError"
				class="mb-6 p-4 rounded-lg bg-error-subtle border border-error/20 text-error flex items-center gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 flex-shrink-0" />
				{{ saveError }}
			</div>

			<div class="mb-6">
				<UiTabs v-model="activeTab" :tabs="tabOptions" />
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main Info -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Contact Details Card -->
					<div v-if="isAdmin || activeTab === 'profile'" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.audience.contacts.detail.contactDetails') }}
						</h2>

						<div class="space-y-4">
							<!-- Email -->
							<div>
								<label class="label">{{
									t('dashboard.audience.contacts.detail.fields.email')
								}}</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.email"
										type="email"
										class="input"
										:placeholder="t('dashboard.audience.contacts.detail.fields.emailPlaceholder')"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span class="text-text-primary">{{ contact.email }}</span>
								</div>
							</div>

							<!-- First Name -->
							<div>
								<label class="label">{{
									t('dashboard.audience.contacts.detail.fields.firstName')
								}}</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.firstName"
										type="text"
										class="input"
										:placeholder="
											t('dashboard.audience.contacts.detail.fields.firstNamePlaceholder')
										"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.firstName ? 'text-text-primary' : 'text-text-tertiary'">
										{{ contact.firstName || t('dashboard.audience.contacts.detail.notSet') }}
									</span>
								</div>
							</div>

							<!-- Last Name -->
							<div>
								<label class="label">{{
									t('dashboard.audience.contacts.detail.fields.lastName')
								}}</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.lastName"
										type="text"
										class="input"
										:placeholder="
											t('dashboard.audience.contacts.detail.fields.lastNamePlaceholder')
										"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.lastName ? 'text-text-primary' : 'text-text-tertiary'">
										{{ contact.lastName || t('dashboard.audience.contacts.detail.notSet') }}
									</span>
								</div>
							</div>

							<!-- Timezone -->
							<div>
								<label class="label">{{
									t('dashboard.audience.contacts.detail.fields.timezone')
								}}</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:globe" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<select v-model="editForm.timezone" class="input">
										<option v-for="tz in commonTimezones" :key="tz.value" :value="tz.value">
											{{ tz.label }}
										</option>
									</select>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:globe" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.timezone ? 'text-text-primary' : 'text-text-tertiary'">
										{{ getTimezoneLabel(contact.timezone) }}
									</span>
								</div>
							</div>

							<!-- Language -->
							<div>
								<label class="label">{{
									t('dashboard.audience.contacts.detail.fields.language')
								}}</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:languages" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<select v-model="editForm.language" class="input">
										<option v-for="lang in commonLanguages" :key="lang.value" :value="lang.value">
											{{ lang.label }}
										</option>
									</select>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:languages" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.language ? 'text-text-primary' : 'text-text-tertiary'">
										{{ getLanguageLabel(contact.language) }}
									</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Custom Properties Card -->
					<div v-if="isAdmin && properties && properties.length > 0" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.audience.contacts.detail.customProperties') }}
						</h2>

						<!-- Edit mode: one input per property -->
						<div v-if="isEditing" class="space-y-4">
							<div v-for="property in properties" :key="property._id">
								<label class="label">{{ property.label }}</label>
								<select
									v-if="property.type === 'boolean'"
									v-model="propertyForm[property._id]"
									class="input"
								>
									<option value="">{{ t('dashboard.audience.contacts.detail.notSet') }}</option>
									<option value="true">{{ t('common.yes') }}</option>
									<option value="false">{{ t('common.no') }}</option>
								</select>
								<input
									v-else
									v-model="propertyForm[property._id]"
									:type="
										property.type === 'number'
											? 'number'
											: property.type === 'date'
												? 'date'
												: 'text'
									"
									class="input"
									:placeholder="property.label"
								/>
							</div>
						</div>

						<!-- Read mode -->
						<div v-else class="space-y-4">
							<div
								v-for="property in properties"
								:key="property._id"
								class="flex items-center justify-between py-2 border-b border-border-subtle last:border-b-0"
							>
								<span class="text-text-secondary">{{ property.label }}</span>
								<span
									:class="
										getPropertyValue(property._id) ? 'text-text-primary' : 'text-text-tertiary'
									"
								>
									{{
										getPropertyValue(property._id) || t('dashboard.audience.contacts.detail.notSet')
									}}
								</span>
							</div>
						</div>
					</div>

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
							<UiButton size="sm" :loading="isSavingNotes" @click="saveNotes">{{
								t('dashboard.audience.contacts.detail.teamNote.save')
							}}</UiButton>
						</div>
						<UiTextarea
							v-model="notesDraft"
							:rows="4"
							:placeholder="t('dashboard.audience.contacts.detail.teamNote.placeholder')"
						/>
					</div>

					<!-- Activity Tab -->
					<div v-if="isAdmin && activeTab === 'activity'" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">
							{{ t('dashboard.audience.contacts.detail.activity.title') }}
						</h2>

						<!-- Loading State -->
						<div
							v-if="activitiesLoading && accumulatedActivities.length === 0"
							class="flex items-center justify-center py-8"
						>
							<div class="flex flex-col items-center gap-3">
								<UiSpinner size="md" />
								<p class="text-text-tertiary text-sm">
									{{ t('dashboard.audience.contacts.detail.activity.loading') }}
								</p>
							</div>
						</div>

						<!-- Empty State -->
						<div
							v-else-if="accumulatedActivities.length === 0"
							class="flex flex-col items-center justify-center py-8 text-center"
						>
							<UiIconBox
								icon="lucide:clock"
								size="lg"
								variant="surface"
								rounded="full"
								class="mb-3"
							/>
							<p class="text-text-secondary text-sm">
								{{ t('dashboard.audience.contacts.detail.activity.emptyTitle') }}
							</p>
							<p class="text-text-tertiary text-sm mt-1">
								{{ t('dashboard.audience.contacts.detail.activity.emptyBody') }}
							</p>
						</div>

						<!-- Activity List -->
						<div v-else class="space-y-1">
							<div
								v-for="(activity, index) in accumulatedActivities"
								:key="activity._id"
								class="relative"
							>
								<!-- Timeline connector line -->
								<div
									v-if="index < accumulatedActivities.length - 1"
									class="absolute left-5 top-10 bottom-0 w-px bg-border-subtle"
								/>

								<!-- Activity item -->
								<div class="flex items-start gap-4 py-3">
									<!-- Icon -->
									<div
										class="flex-shrink-0 w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center"
										:class="getActivityColor(activity.activityType)"
									>
										<Icon :name="getActivityIcon(activity.activityType)" class="w-5 h-5" />
									</div>

									<!-- Content -->
									<div class="flex-1 min-w-0">
										<p class="text-text-primary text-sm font-medium">
											{{ getActivityLabel(activity.activityType) }}
										</p>
										<p
											v-if="getActivityDescription(activity.activityType, activity.metadata)"
											class="text-text-secondary text-sm mt-0.5 truncate"
										>
											{{ getActivityDescription(activity.activityType, activity.metadata) }}
										</p>
										<p class="text-text-tertiary text-xs mt-1">
											{{ formatActivityTime(activity.occurredAt) }}
										</p>
									</div>
								</div>
							</div>

							<!-- Load More Button -->
							<div v-if="hasMoreActivities" class="pt-4 text-center">
								<UiButton
									variant="secondary"
									size="sm"
									:disabled="isLoadingMoreActivities"
									@click="loadMoreActivities"
								>
									<Icon
										v-if="isLoadingMoreActivities"
										name="lucide:loader-2"
										class="w-4 h-4 animate-spin motion-reduce:animate-none mr-2"
									/>
									{{
										isLoadingMoreActivities
											? t('common.loading')
											: t('dashboard.audience.contacts.detail.activity.loadMore')
									}}
								</UiButton>
							</div>
						</div>
					</div>

					<!-- Unified Timeline Tab -->
					<ContactsUnifiedTimelineTab v-if="activeTab === 'timeline'" :contact-id="contactId" />

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
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ formatDateTime(contact.createdAt) }}
								</div>
							</div>

							<div>
								<p class="text-sm text-text-tertiary">
									{{ t('dashboard.audience.contacts.detail.lastUpdated') }}
								</p>
								<div class="flex items-center gap-2 text-text-primary">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ formatDateTime(contact.updatedAt) }}
								</div>
							</div>
						</div>
					</div>

					<!-- Topics Card -->
					<div v-if="isAdmin" class="card">
						<div class="flex items-center justify-between mb-4">
							<h2 class="text-lg font-medium text-text-primary">
								{{ t('dashboard.audience.contacts.detail.topics.title') }}
							</h2>

							<!-- Add to Topic Dropdown -->
							<div ref="addToTopicDropdownRef" class="relative">
								<UiButton
									variant="secondary"
									size="sm"
									class="gap-1.5"
									:disabled="availableTopicsToAdd.length === 0 || isAddingToTopic"
									@click.stop="isAddToTopicDropdownOpen = !isAddToTopicDropdownOpen"
								>
									<Icon
										v-if="isAddingToTopic"
										name="lucide:loader-2"
										class="w-3 h-3 animate-spin motion-reduce:animate-none"
									/>
									<Icon v-else name="lucide:plus" class="w-3 h-3" />
									{{ t('dashboard.audience.contacts.detail.topics.addToTopic') }}
									<Icon name="lucide:chevron-down" class="w-3 h-3" />
								</UiButton>

								<!-- Dropdown Menu -->
								<Transition
									enter-active-class="duration-(--motion-moderate) ease-spring"
									enter-from-class="opacity-0 translate-y-1"
									enter-to-class="opacity-100 translate-y-0"
									leave-active-class="duration-(--motion-moderate-exit) ease-exit"
									leave-from-class="opacity-100 translate-y-0"
									leave-to-class="opacity-0 translate-y-1"
								>
									<div
										v-if="isAddToTopicDropdownOpen && availableTopicsToAdd.length > 0"
										class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 py-1 max-h-64 overflow-y-auto"
									>
										<button
											v-for="list in availableTopicsToAdd"
											:key="list._id"
											class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
											:disabled="isAddingToTopic"
											@click="handleAddToTopic(list._id)"
										>
											<Icon name="lucide:tag" class="w-4 h-4 text-brand flex-shrink-0" />
											<span class="truncate">{{ list.name }}</span>
										</button>
									</div>
								</Transition>

								<!-- Empty Dropdown Message -->
								<Transition
									enter-active-class="duration-(--motion-moderate) ease-spring"
									enter-from-class="opacity-0 translate-y-1"
									enter-to-class="opacity-100 translate-y-0"
									leave-active-class="duration-(--motion-moderate-exit) ease-exit"
									leave-from-class="opacity-100 translate-y-0"
									leave-to-class="opacity-0 translate-y-1"
								>
									<div
										v-if="
											isAddToTopicDropdownOpen &&
											availableTopicsToAdd.length === 0 &&
											allTopics &&
											allTopics.length > 0
										"
										class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 p-3"
									>
										<p class="text-sm text-text-tertiary text-center">
											{{ t('dashboard.audience.contacts.detail.topics.allTopics') }}
										</p>
									</div>
								</Transition>
							</div>
						</div>

						<div v-if="contactTopics && contactTopics.length > 0" class="space-y-2">
							<div
								v-for="list in contactTopics"
								:key="list._id"
								class="group flex items-center gap-2 p-2 rounded-lg bg-bg-surface"
							>
								<Icon name="lucide:tag" class="w-4 h-4 text-brand flex-shrink-0" />
								<div class="flex-1 min-w-0">
									<NuxtLink
										:to="`/dashboard/audience/topics/${list._id}`"
										class="text-text-primary text-sm truncate hover:text-brand transition-colors block"
									>
										{{ list.name }}
									</NuxtLink>
								</div>
								<button
									class="p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error-subtle transition-all"
									:title="t('dashboard.audience.contacts.detail.topics.remove')"
									@click="handleRemoveFromTopic(list._id)"
								>
									<Icon name="lucide:x" class="w-3 h-3" />
								</button>
							</div>
						</div>
						<div v-else-if="allTopics && allTopics.length === 0" class="text-center py-4">
							<p class="text-text-tertiary text-sm">
								{{ t('dashboard.audience.contacts.detail.topics.noneCreated') }}
							</p>
							<NuxtLink to="/dashboard/audience/topics" class="text-brand text-sm hover:underline">
								{{ t('dashboard.audience.contacts.detail.topics.createOne') }}
							</NuxtLink>
						</div>
						<div v-else class="text-center py-4">
							<p class="text-text-tertiary text-sm">
								{{ t('dashboard.audience.contacts.detail.topics.none') }}
							</p>
						</div>
					</div>
				</div>
			</div>
		</template>

		<!-- Delete Confirmation Modal -->
		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<!-- Backdrop -->
					<div class="absolute inset-0 bg-scrim/60" @click="showDeleteConfirm = false" />

					<!-- Modal -->
					<div
						class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-md"
					>
						<div class="flex items-center gap-4 mb-4">
							<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
								<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
							</div>
							<div>
								<h3 class="text-lg font-semibold text-text-primary">
									{{ t('dashboard.audience.contacts.detail.deleteDialog.title') }}
								</h3>
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.audience.contacts.detail.deleteDialog.subtitle') }}
								</p>
							</div>
						</div>

						<I18nT
							keypath="dashboard.audience.contacts.detail.deleteDialog.body"
							tag="p"
							class="text-text-secondary mb-6"
							scope="global"
						>
							<template #email>
								<span class="font-medium text-text-primary">{{ contact?.email }}</span>
							</template>
						</I18nT>

						<div class="flex items-center justify-end gap-3">
							<UiButton
								variant="secondary"
								:disabled="isDeleting"
								@click="showDeleteConfirm = false"
							>
								{{ t('common.cancel') }}
							</UiButton>
							<UiButton variant="danger" :disabled="isDeleting" @click="confirmDelete">
								<UiSpinner v-if="isDeleting" class="mr-2" size="xs" tone="inverse" />
								{{
									isDeleting
										? t('dashboard.audience.contacts.detail.deleting')
										: t('dashboard.audience.contacts.detail.deleteDialog.title')
								}}
							</UiButton>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
