<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Contact Details — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();

// Get contact ID from route
const contactId = computed(() => route.params['id'] as Id<'contacts'>);

// GDPR data-subject access export: lazily fetch the full personal-data bundle
// on demand and download it as JSON. The query is skipped until requested.
const exportRequested = ref(false);
const { data: exportData } = useConvexQuery(
	api.contacts.dataExport.exportContactData,
	() => (exportRequested.value ? { contactId: contactId.value } : 'skip'),
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
		showToast('Confirmation email sent');
	} else {
		showToast('Could not resend confirmation', 'error');
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
	formatDate,
	getDoiStatusLabel,
	getDoiStatusColor,
	getDoiStatusIcon,
} = useContactDetail(contactId);

// Activity Timeline
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
} = useActivityTimeline(contactId);

// Tab navigation
const activeTab = ref('activity');
const tabOptions = [
	{ value: 'activity', label: 'Activity' },
	{ value: 'timeline', label: 'Timeline' },
	{ value: 'knowledge', label: 'Knowledge' },
	{ value: 'files', label: 'Files' },
	{ value: 'identities', label: 'Identities' },
	{ value: 'relationships', label: 'Relationships' },
];

// Topics
const { data: contactTopics } = useConvexQuery(api.topics.topics.getTopicsForContact, () => ({
	contactId: contactId.value,
}));

const { results: allTopics } = useTopicsList();

const { run: addToTopic } = useBackendOperation(api.topics.topics.addContact, {
	label: 'Add to topic',
});
const { run: removeFromTopic } = useBackendOperation(api.topics.topics.removeContact, {
	label: 'Remove from topic',
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
	if (result === undefined) return;
	const topicName = allTopics.value?.find((t) => t._id === topicId)?.name || 'topic';
	showToast(`Added to "${topicName}"`);
	isAddToTopicDropdownOpen.value = false;
};

const handleRemoveFromTopic = async (topicId: Id<'topics'>) => {
	const result = await removeFromTopic({
		topicId,
		contactId: contactId.value,
	});
	if (result === undefined) return;
	const topicName = contactTopics.value?.find((t) => t._id === topicId)?.name || 'topic';
	showToast(`Removed from "${topicName}"`);
};

// Close dropdown when clicking outside
const addToTopicDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(addToTopicDropdownRef, () => {
	isAddToTopicDropdownOpen.value = false;
});

// Toast notifications (global)
const { showToast } = useToast();
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Back Navigation -->
		<NuxtLink
			to="/dashboard/audience/contacts"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Contacts
		</NuxtLink>

		<!-- Loading State -->
		<div v-if="contactLoading && !contact" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading contact...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div
			v-else-if="!contactLoading && !contact"
			class="flex flex-col items-center justify-center py-16 text-center"
		>
			<UiIconBox icon="lucide:alert-circle" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Contact not found</p>
			<p class="text-sm text-text-tertiary mt-1">
				This contact may have been deleted or you don't have access.
			</p>
			<NuxtLink to="/dashboard/audience/contacts" class="btn btn-secondary mt-6">
				Back to Contacts
			</NuxtLink>
		</div>

		<!-- Contact Content -->
		<template v-else-if="contact">
			<!-- Header -->
			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
				<div class="flex items-center gap-4">
					<UiIconBox icon="lucide:user" size="xl" variant="surface" rounded="full" />
					<div>
						<h1 class="text-2xl font-semibold text-text-primary">
							{{
								contact.firstName || contact.lastName
									? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
									: contact.email
							}}
						</h1>
						<p class="text-text-secondary mt-1">{{ contact.email }}</p>
						<!-- Double-opt-in confirmation status -->
						<div
							v-if="getDoiStatusLabel(contact.doiStatus)"
							class="mt-2 inline-flex items-center gap-1.5 text-sm"
							:class="getDoiStatusColor(contact.doiStatus)"
						>
							<Icon
								v-if="getDoiStatusIcon(contact.doiStatus)"
								:name="getDoiStatusIcon(contact.doiStatus)!"
								class="w-4 h-4"
							/>
							<span>{{ getDoiStatusLabel(contact.doiStatus) }} confirmation</span>
						</div>
					</div>
				</div>

				<div class="flex items-center gap-2">
					<template v-if="isEditing">
						<button class="btn btn-ghost" :disabled="isSaving" @click="cancelEditing">
							Cancel
						</button>
						<button class="btn btn-primary gap-2" :disabled="isSaving" @click="saveChanges">
							<div
								v-if="isSaving"
								class="w-4 h-4 border-2 border-bg-deep border-t-transparent rounded-full animate-spin"
							/>
							<Icon v-else name="lucide:save" class="w-4 h-4" />
							Save Changes
						</button>
					</template>
					<template v-else>
						<button
							v-if="contact.doiStatus === 'pending'"
							class="btn btn-secondary gap-2"
							:disabled="isResendingDoi"
							title="Re-send the double-opt-in confirmation email to this pending contact"
							@click="handleResendDoi"
						>
							<Icon
								v-if="isResendingDoi"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin"
							/>
							<Icon v-else name="lucide:mail-check" class="w-4 h-4" />
							{{ isResendingDoi ? 'Sending…' : 'Resend confirmation' }}
						</button>
						<button class="btn btn-secondary gap-2" @click="startEditing">
							<Icon name="lucide:pencil" class="w-4 h-4" />
							Edit
						</button>
						<button
							class="btn btn-secondary gap-2"
							:disabled="exportRequested"
							title="Export this contact's personal data (GDPR access request)"
							@click="handleExportData"
						>
							<Icon name="lucide:download" class="w-4 h-4" />
							{{ exportRequested ? 'Exporting…' : 'Export data' }}
						</button>
						<button
							class="btn btn-ghost text-error hover:bg-error-subtle"
							@click="showDeleteConfirm = true"
						 aria-label="Delete">
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</template>
				</div>
			</div>

			<!-- Error Message -->
			<div
				v-if="saveError"
				class="mb-6 p-4 rounded-lg bg-error-subtle border border-error/20 text-error flex items-center gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 flex-shrink-0" />
				{{ saveError }}
			</div>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main Info -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Contact Details Card -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Contact Details</h2>

						<div class="space-y-4">
							<!-- Email -->
							<div>
								<label class="label">Email Address</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.email"
										type="email"
										class="input"
										placeholder="email@example.com"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span class="text-text-primary">{{ contact.email }}</span>
								</div>
							</div>

							<!-- First Name -->
							<div>
								<label class="label">First Name</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.firstName"
										type="text"
										class="input"
										placeholder="First name"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.firstName ? 'text-text-primary' : 'text-text-tertiary'">
										{{ contact.firstName || 'Not set' }}
									</span>
								</div>
							</div>

							<!-- Last Name -->
							<div>
								<label class="label">Last Name</label>
								<div v-if="isEditing" class="flex items-center gap-3">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<input
										v-model="editForm.lastName"
										type="text"
										class="input"
										placeholder="Last name"
									/>
								</div>
								<div v-else class="flex items-center gap-3 py-2">
									<Icon name="lucide:user" class="w-5 h-5 text-text-tertiary flex-shrink-0" />
									<span :class="contact.lastName ? 'text-text-primary' : 'text-text-tertiary'">
										{{ contact.lastName || 'Not set' }}
									</span>
								</div>
							</div>

							<!-- Timezone -->
							<div>
								<label class="label">Timezone</label>
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
								<label class="label">Preferred Language</label>
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
					<div v-if="properties && properties.length > 0" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Custom Properties</h2>

						<!-- Edit mode: one input per property -->
						<div v-if="isEditing" class="space-y-4">
							<div v-for="property in properties" :key="property._id">
								<label class="label">{{ property.label }}</label>
								<select
									v-if="property.type === 'boolean'"
									v-model="propertyForm[property._id]"
									class="input"
								>
									<option value="">Not set</option>
									<option value="true">Yes</option>
									<option value="false">No</option>
								</select>
								<input
									v-else
									v-model="propertyForm[property._id]"
									:type="property.type === 'number' ? 'number' : property.type === 'date' ? 'date' : 'text'"
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
									{{ getPropertyValue(property._id) || 'Not set' }}
								</span>
							</div>
						</div>
					</div>

					<!-- Tab Navigation -->
					<div class="mb-6">
						<UiTabs v-model="activeTab" :tabs="tabOptions" />
					</div>

					<!-- Activity Tab -->
					<div v-if="activeTab === 'activity'" class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Activity Timeline</h2>

						<!-- Loading State -->
						<div
							v-if="activitiesLoading && accumulatedActivities.length === 0"
							class="flex items-center justify-center py-8"
						>
							<div class="flex flex-col items-center gap-3">
								<UiSpinner size="md" />
								<p class="text-text-tertiary text-sm">Loading activities...</p>
							</div>
						</div>

						<!-- Empty State -->
						<div
							v-else-if="accumulatedActivities.length === 0"
							class="flex flex-col items-center justify-center py-8 text-center"
						>
							<UiIconBox icon="lucide:clock" size="lg" variant="surface" rounded="full" class="mb-3" />
							<p class="text-text-secondary text-sm">No activity yet</p>
							<p class="text-text-tertiary text-sm mt-1">
								Activity will appear here when you send emails to this contact.
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
								<button
									class="btn btn-secondary btn-sm"
									:disabled="isLoadingMoreActivities"
									@click="loadMoreActivities"
								>
									<Icon v-if="isLoadingMoreActivities" name="lucide:loader-2" class="w-4 h-4 animate-spin mr-2" />
									{{ isLoadingMoreActivities ? 'Loading...' : 'Load More' }}
								</button>
							</div>
						</div>
					</div>

					<!-- Unified Timeline Tab -->
					<ContactsUnifiedTimelineTab
						v-if="activeTab === 'timeline'"
						:contact-id="contactId"
					/>

					<!-- Knowledge Tab -->
					<ContactsContactKnowledgeTab
						v-if="activeTab === 'knowledge'"
						:contact-id="contactId"
					/>

					<!-- Files Tab -->
					<ContactsContactFilesTab
						v-if="activeTab === 'files'"
						:contact-id="contactId"
					/>

					<!-- Identities Tab -->
					<ContactsIdentitiesTab
						v-if="activeTab === 'identities'"
						:contact-id="contactId"
						@toast="showToast"
					/>

					<!-- Relationships Tab -->
					<ContactsRelationshipsTab
						v-if="activeTab === 'relationships'"
						:contact-id="contactId"
						@toast="showToast"
					/>
				</div>

				<!-- Sidebar -->
				<div class="space-y-6">
					<!-- Communication Stats Card -->
					<ContactsTimelineStatsCard :contact-id="contactId" />

					<!-- Metadata Card -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">Details</h2>

						<div class="space-y-4">
							<div>
								<p class="text-sm text-text-tertiary">Source</p>
								<p class="text-text-primary capitalize">{{ contact.source || 'Unknown' }}</p>
							</div>

							<div>
								<p class="text-sm text-text-tertiary">Created</p>
								<div class="flex items-center gap-2 text-text-primary">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ formatDate(contact.createdAt) }}
								</div>
							</div>

							<div>
								<p class="text-sm text-text-tertiary">Last Updated</p>
								<div class="flex items-center gap-2 text-text-primary">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ formatDate(contact.updatedAt) }}
								</div>
							</div>
						</div>
					</div>

					<!-- Topics Card -->
					<div class="card">
						<div class="flex items-center justify-between mb-4">
							<h2 class="text-lg font-medium text-text-primary">Topics</h2>

							<!-- Add to Topic Dropdown -->
							<div ref="addToTopicDropdownRef" class="relative">
								<button
									class="btn btn-secondary btn-sm gap-1.5"
									:disabled="availableTopicsToAdd.length === 0 || isAddingToTopic"
									@click.stop="isAddToTopicDropdownOpen = !isAddToTopicDropdownOpen"
								>
									<Icon v-if="isAddingToTopic" name="lucide:loader-2" class="w-3 h-3 animate-spin" />
									<Icon v-else name="lucide:plus" class="w-3 h-3" />
									Add to Topic
									<Icon name="lucide:chevron-down" class="w-3 h-3" />
								</button>

								<!-- Dropdown Menu -->
								<Transition
									enter-active-class="duration-150 ease-out"
									enter-from-class="opacity-0 translate-y-1"
									enter-to-class="opacity-100 translate-y-0"
									leave-active-class="duration-100 ease-in"
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
									enter-active-class="duration-150 ease-out"
									enter-from-class="opacity-0 translate-y-1"
									enter-to-class="opacity-100 translate-y-0"
									leave-active-class="duration-100 ease-in"
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
											Contact is already in all topics
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
									title="Remove from topic"
									@click="handleRemoveFromTopic(list._id)"
								>
									<Icon name="lucide:x" class="w-3 h-3" />
								</button>
							</div>
						</div>
						<div
							v-else-if="allTopics && allTopics.length === 0"
							class="text-center py-4"
						>
							<p class="text-text-tertiary text-sm">No topics created yet</p>
							<NuxtLink to="/dashboard/audience/topics" class="text-brand text-sm hover:underline">
								Create a topic
							</NuxtLink>
						</div>
						<div v-else class="text-center py-4">
							<p class="text-text-tertiary text-sm">Not in any topics</p>
						</div>
					</div>
				</div>
			</div>
		</template>

		<!-- Delete Confirmation Modal -->
		<Teleport to="body">
			<Transition
				enter-active-class="duration-200 ease-out"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="duration-150 ease-in"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="showDeleteConfirm"
					class="fixed inset-0 z-50 flex items-center justify-center p-4"
				>
					<!-- Backdrop -->
					<div class="absolute inset-0 bg-black/60" @click="showDeleteConfirm = false" />

					<!-- Modal -->
					<div
						class="relative bg-bg-elevated border border-border-subtle rounded-2xl p-6 w-full max-w-md"
					>
						<div class="flex items-center gap-4 mb-4">
							<div class="p-3 rounded-full bg-error-subtle flex items-center justify-center">
								<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
							</div>
							<div>
								<h3 class="text-lg font-semibold text-text-primary">Delete Contact</h3>
								<p class="text-sm text-text-secondary">Hidden now, permanently erased after 30 days.</p>
							</div>
						</div>

						<p class="text-text-secondary mb-6">
							Are you sure you want to delete
							<span class="font-medium text-text-primary">{{ contact?.email }}</span
							>? The contact is hidden immediately and permanently erased — along with its
							topic memberships and custom properties — after the 30-day retention period.
						</p>

						<div class="flex items-center justify-end gap-3">
							<button
								class="btn btn-secondary"
								:disabled="isDeleting"
								@click="showDeleteConfirm = false"
							>
								Cancel
							</button>
							<button
								class="btn bg-error text-white hover:bg-error/90"
								:disabled="isDeleting"
								@click="confirmDelete"
							>
								<div
									v-if="isDeleting"
									class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"
								/>
								{{ isDeleting ? 'Deleting...' : 'Delete Contact' }}
							</button>
						</div>
					</div>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
