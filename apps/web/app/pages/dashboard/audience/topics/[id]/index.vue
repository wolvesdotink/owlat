<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Topic — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();

// Breadcrumbs
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();

// Get the topic ID from the route
const topicId = computed(() => route.params['id'] as Id<'topics'>);

// Get the current user's organization (organizationLoading used for loading state)
const { isLoading: organizationLoading } = useOrganizationContext();

// Fetch topic details
const { data: topic, isLoading: topicLoading } = useConvexQuery(api.topics.topics.get, () => ({
	topicId: topicId.value,
}));

// Fetch contacts in this topic (paginated)
const {
	results: topicContacts,
	isLoading: contactsLoading,
	loadMore,
	status: contactsPaginationStatus,
} = usePaginatedQuery(
	api.topics.topics.getContacts,
	() => ({ topicId: topicId.value }),
	{ initialNumItems: 50 }
);

const isLoading = computed(
	() => organizationLoading.value || topicLoading.value || contactsLoading.value
);

// Update breadcrumbs when topic data is loaded
watch(
	topic,
	(t) => {
		if (t) {
			setDynamicBreadcrumbs([
				{ label: 'Audience', href: '/dashboard/audience' },
				{ label: 'Topics', href: '/dashboard/audience/topics' },
				{ label: t.name },
			]);
		}
	},
	{ immediate: true }
);

// Clear dynamic breadcrumbs on unmount
onUnmounted(() => {
	clearDynamicBreadcrumbs();
});

// Search state
const searchQuery = ref('');
const debouncedSearch = ref('');
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

// Debounce search input
watch(searchQuery, (value) => {
	if (searchTimeout) {
		clearTimeout(searchTimeout);
	}
	searchTimeout = setTimeout(() => {
		debouncedSearch.value = value;
	}, 300);
});

// Pagination state
const currentPage = ref(1);
const pageSize = 25;

// Sorting state
type SortField = 'email' | 'firstName' | 'lastName' | 'addedAt';
const sortBy = ref<SortField>('addedAt');
const sortOrder = ref<'asc' | 'desc'>('desc');

// Reset to page 1 when search or sort changes
watch([debouncedSearch, sortBy, sortOrder], () => {
	currentPage.value = 1;
});

// Filtered and sorted contacts
const filteredContacts = computed(() => {
	if (!topicContacts.value) return [];

	let contacts = [...topicContacts.value];

	// Filter by search
	if (debouncedSearch.value) {
		const query = debouncedSearch.value.toLowerCase();
		contacts = contacts.filter(
			(contact) =>
				(contact.email && contact.email.toLowerCase().includes(query)) ||
				(contact.firstName && contact.firstName.toLowerCase().includes(query)) ||
				(contact.lastName && contact.lastName.toLowerCase().includes(query))
		);
	}

	// Sort
	contacts.sort((a, b) => {
		let comparison = 0;
		if (sortBy.value === 'email') {
			comparison = (a.email ?? '').localeCompare(b.email ?? '');
		} else if (sortBy.value === 'firstName') {
			comparison = (a.firstName || '').localeCompare(b.firstName || '');
		} else if (sortBy.value === 'lastName') {
			comparison = (a.lastName || '').localeCompare(b.lastName || '');
		} else if (sortBy.value === 'addedAt') {
			comparison = a.addedAt - b.addedAt;
		}
		return sortOrder.value === 'asc' ? comparison : -comparison;
	});

	return contacts;
});

// Paginated contacts
const paginatedContacts = computed(() => {
	const start = (currentPage.value - 1) * pageSize;
	return filteredContacts.value.slice(start, start + pageSize);
});

// Pagination calculations
const totalPages = computed(() => Math.max(1, Math.ceil(filteredContacts.value.length / pageSize)));
const totalCount = computed(() => filteredContacts.value.length);

const canGoPrev = computed(() => currentPage.value > 1);
const canGoNext = computed(() => currentPage.value < totalPages.value);

// The server query is cursor-paginated (50/page) but the table pages
// client-side over the loaded set; without driving loadMore, members past the
// first page were unreachable. Progressively pull more pages: when the user
// nears the end of the loaded window, and eagerly while a search is active
// (client-side search must see every member to find a match).
const canLoadMore = computed(() => contactsPaginationStatus.value === 'CanLoadMore');
watch(
	[currentPage, debouncedSearch, contactsPaginationStatus],
	() => {
		if (!canLoadMore.value) return;
		const loaded = topicContacts.value?.length ?? 0;
		const needed = currentPage.value * pageSize + pageSize;
		if (debouncedSearch.value || loaded < needed) {
			loadMore(50);
		}
	},
	{ immediate: true }
);

const goToPage = (page: number) => {
	if (page >= 1 && page <= totalPages.value) {
		currentPage.value = page;
	}
};

// Handle column sort
const handleSort = (field: SortField) => {
	if (sortBy.value === field) {
		sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc';
	} else {
		sortBy.value = field;
		sortOrder.value = field === 'addedAt' ? 'desc' : 'asc';
	}
};

// Get sort icon for column
const getSortIcon = (field: SortField): string | null => {
	if (sortBy.value !== field) return null;
	return sortOrder.value === 'asc' ? 'lucide:chevron-up' : 'lucide:chevron-down';
};

// Generate page numbers for pagination
const pageNumbers = computed(() => {
	const pages: (number | '...')[] = [];
	const total = totalPages.value;
	const current = currentPage.value;

	if (total <= 7) {
		for (let i = 1; i <= total; i++) {
			pages.push(i);
		}
	} else {
		if (current <= 3) {
			pages.push(1, 2, 3, 4, '...', total);
		} else if (current >= total - 2) {
			pages.push(1, '...', total - 3, total - 2, total - 1, total);
		} else {
			pages.push(1, '...', current - 1, current, current + 1, '...', total);
		}
	}

	return pages;
});

// Showing range text
const showingRange = computed(() => {
	if (totalCount.value === 0) return '0 contacts';
	const start = (currentPage.value - 1) * pageSize + 1;
	const end = Math.min(currentPage.value * pageSize, totalCount.value);
	return `${start}-${end} of ${totalCount.value}`;
});

// ============================================
// Remove Contact Modal State
// ============================================
const isRemoveModalOpen = ref(false);
const removeTarget = ref<{
	id: Id<'contacts'>;
	email?: string;
} | null>(null);
const isRemoving = ref(false);

// Remove contact mutation
const { run: removeContact } = useBackendOperation(api.topics.topics.removeContact, {
	label: 'Remove from topic',
});

// Open remove modal
const openRemoveModal = (contact: { _id: Id<'contacts'>; email?: string }) => {
	removeTarget.value = {
		id: contact._id,
		email: contact.email,
	};
	isRemoveModalOpen.value = true;
};

// Close remove modal
const closeRemoveModal = () => {
	isRemoveModalOpen.value = false;
	removeTarget.value = null;
};

// Handle remove confirmation
const handleRemove = async () => {
	if (!removeTarget.value) return;

	isRemoving.value = true;

	const result = await removeContact({
		topicId: topicId.value,
		contactId: removeTarget.value.id,
	});
	isRemoving.value = false;
	if (result === undefined) return;
	showToast(`Removed "${removeTarget.value.email ?? 'contact'}" from the topic`);
	closeRemoveModal();
};

// ============================================
// Toast Notification (global)
// ============================================
const { showToast } = useToast();

// Navigate to contact in topic detail
const viewContact = (contactId: Id<'contacts'>) => {
	router.push(`/dashboard/audience/topics/${topicId.value}/contacts/${contactId}`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !topic" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading topic...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div
			v-else-if="!isLoading && !topic"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:list" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Topic not found</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				This topic may have been deleted or doesn't exist.
			</p>
			<NuxtLink to="/dashboard/audience/topics" class="btn btn-primary mt-6">
				Back to Topics
			</NuxtLink>
		</div>

		<!-- Main Content -->
		<template v-else-if="topic">
			<!-- Header -->
			<div class="mb-6">
				<!-- Back link and title -->
				<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
					<div class="flex items-start gap-4">
						<NuxtLink
							to="/dashboard/audience/topics"
							class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors mt-1"
						>
							<Icon name="lucide:arrow-left" class="w-5 h-5" />
						</NuxtLink>
						<div>
							<div class="flex items-center gap-3">
								<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
									<Icon name="lucide:list" class="w-5 h-5 text-brand" />
								</div>
								<h1 class="text-2xl font-semibold text-text-primary">
									{{ topic.name }}
								</h1>
							</div>
							<p v-if="topic.description" class="mt-2 text-text-secondary">
								{{ topic.description }}
							</p>
							<div class="flex items-center flex-wrap gap-4 mt-3 text-sm text-text-tertiary">
								<div class="flex items-center gap-1.5">
									<Icon name="lucide:users" class="w-4 h-4" />
									<span
										>{{ topic.contactCount }} contact{{
											topic.contactCount !== 1 ? 's' : ''
										}}</span
									>
								</div>
								<div class="flex items-center gap-1.5">
									<Icon name="lucide:calendar" class="w-4 h-4" />
									<span>Created {{ formatDate(topic.createdAt) }}</span>
								</div>
								<div
									v-if="topic.requireDoubleOptIn"
									class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-brand/10 text-brand"
								>
									<Icon name="lucide:shield" class="w-3.5 h-3.5" />
									<span>Double Opt-In Required</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Search Bar -->
			<div class="mb-6">
				<div class="relative max-w-md">
					<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
					<input
						v-model="searchQuery"
						type="text"
						placeholder="Search contacts in this topic..."
						class="input pl-10"
					/>
				</div>
			</div>

			<!-- Contacts Table -->
			<div class="card p-0 overflow-hidden">
				<!-- Empty State (no contacts in topic) -->
				<div
					v-if="!contactsLoading && filteredContacts.length === 0 && !debouncedSearch"
					class="flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:users" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">No contacts in this topic</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						Add contacts to this topic from the contact detail page.
					</p>
					<NuxtLink to="/dashboard/audience/contacts" class="btn btn-primary gap-2 mt-6">
						Browse Contacts
					</NuxtLink>
				</div>

				<!-- Empty State (no search results) -->
				<div
					v-else-if="!contactsLoading && filteredContacts.length === 0 && debouncedSearch"
					class="flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">No results found</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						No contacts match "{{ debouncedSearch }}". Try a different search term.
					</p>
					<button
						class="btn btn-secondary mt-6"
						@click="
							searchQuery = '';
							debouncedSearch = '';
						"
					>
						Clear search
					</button>
				</div>

				<!-- Data Table -->
				<div v-else>
					<div class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('email')"
									>
										<div class="flex items-center gap-1">
											Email
											<Icon
												v-if="getSortIcon('email')"
												:name="getSortIcon('email')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('firstName')"
									>
										<div class="flex items-center gap-1">
											First Name
											<Icon
												v-if="getSortIcon('firstName')"
												:name="getSortIcon('firstName')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('lastName')"
									>
										<div class="flex items-center gap-1">
											Last Name
											<Icon
												v-if="getSortIcon('lastName')"
												:name="getSortIcon('lastName')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('addedAt')"
									>
										<div class="flex items-center gap-1">
											Added
											<Icon
												v-if="getSortIcon('addedAt')"
												:name="getSortIcon('addedAt')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								<tr
									v-for="contact in paginatedContacts"
									:key="contact._id"
									class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors cursor-pointer"
									@click="viewContact(contact._id)"
								>
									<td class="px-6 py-4">
										<span class="text-text-primary font-medium">{{ contact.email }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary">{{ contact.firstName || '—' }}</span>
									</td>
									<td class="px-6 py-4">
										<span class="text-text-secondary">{{ contact.lastName || '—' }}</span>
									</td>
										<td class="px-6 py-4">
										<span class="text-text-tertiary text-sm">{{
											formatDate(contact.addedAt)
										}}</span>
									</td>
									<td class="px-6 py-4">
										<div class="flex items-center justify-end gap-1">
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
												title="Remove from topic"
												@click.stop="openRemoveModal(contact)"
											>
												<Icon name="lucide:trash-2" class="w-4 h-4" />
											</button>
										</div>
									</td>
								</tr>
							</tbody>
						</table>
					</div>

					<!-- Pagination -->
					<div
						v-if="totalPages > 1 || totalCount > 0"
						class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-4 border-t border-border-subtle"
					>
						<p class="text-sm text-text-tertiary">Showing {{ showingRange }}</p>

						<div class="flex items-center gap-1">
							<button
								class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors"
								:disabled="!canGoPrev"
								@click="goToPage(currentPage - 1)"
							 aria-label="Previous">
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>

							<template v-for="(page, index) in pageNumbers" :key="index">
								<span v-if="page === '...'" class="px-2 text-text-tertiary"> ... </span>
								<button
									v-else
									:class="[
										'min-w-[32px] h-8 px-2 rounded-lg text-sm font-medium transition-colors',
										page === currentPage
											? 'bg-brand text-text-inverse'
											: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
									]"
									@click="goToPage(page)"
								>
									{{ page }}
								</button>
							</template>

							<button
								class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors"
								:disabled="!canGoNext"
								@click="goToPage(currentPage + 1)"
							 aria-label="Next">
								<Icon name="lucide:chevron-right" class="w-4 h-4" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</template>

		<!-- Remove Contact Modal -->
		<UiConfirmationDialog
			:open="isRemoveModalOpen"
			variant="danger"
			title="Remove from Topic"
			:description="`Remove &quot;${removeTarget?.email ?? ''}&quot; from this topic? The contact will not be deleted, only removed from &quot;${topic?.name ?? ''}&quot;.`"
			confirm-text="Remove"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => { if (!v) closeRemoveModal(); }"
			@confirm="handleRemove"
		/>
	</div>
</template>
