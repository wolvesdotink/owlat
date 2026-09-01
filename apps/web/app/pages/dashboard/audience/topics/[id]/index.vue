<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.topics.detail.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

// Breadcrumbs
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();

// Get the topic ID from the route
const topicId = useRouteId<'topics'>();

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
} = usePaginatedQuery(api.topics.topics.getContacts, () => ({ topicId: topicId.value }), {
	initialNumItems: 50,
});

const isLoading = computed(
	() => organizationLoading.value || topicLoading.value || contactsLoading.value
);

// Below md the five columns have nowhere to go — the same rows render as a card
// list instead (one tap opens the contact, the remove action stays on the row).
const tableFits = useDataTableViewport();

// Update breadcrumbs when topic data is loaded
watch(
	topic,
	(topicDoc) => {
		if (topicDoc) {
			setDynamicBreadcrumbs([
				{
					label: t('dashboard.audience.topics.detail.index.breadcrumbs.audience'),
					href: '/dashboard/audience',
				},
				{
					label: t('dashboard.audience.topics.detail.index.breadcrumbs.topics'),
					href: '/dashboard/audience/topics',
				},
				{ label: topicDoc.name },
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
	if (totalCount.value === 0) return t('dashboard.audience.topics.detail.index.showing.empty');
	const start = (currentPage.value - 1) * pageSize + 1;
	const end = Math.min(currentPage.value * pageSize, totalCount.value);
	return t('dashboard.audience.topics.detail.index.showing.range', {
		start,
		end,
		total: totalCount.value,
	});
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
	label: () => t('dashboard.audience.topics.detail.index.operations.removeContact'),
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
	if (!result.ok) return;
	showToast(
		t('dashboard.audience.topics.detail.index.toasts.removed', {
			email:
				removeTarget.value.email ?? t('dashboard.audience.topics.detail.index.contactFallback'),
		})
	);
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
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.audience.topics.detail.index.loading') }}
				</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div
			v-else-if="!isLoading && !topic"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:list" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.audience.topics.detail.index.notFound.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.audience.topics.detail.index.notFound.body') }}
			</p>
			<UiButton to="/dashboard/audience/topics" class="mt-6">
				{{ t('dashboard.audience.topics.detail.index.notFound.action') }}
			</UiButton>
		</div>

		<!-- Main Content -->
		<template v-else-if="topic">
			<!-- Header: back link, topic icon, then the title ladder -->
			<div class="flex items-start gap-4 mb-6">
				<NuxtLink
					to="/dashboard/audience/topics"
					class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors mt-1"
				>
					<Icon name="lucide:arrow-left" class="w-5 h-5" />
				</NuxtLink>
				<div class="p-2 rounded-lg bg-brand/10 flex items-center justify-center">
					<Icon name="lucide:list" class="w-5 h-5 text-brand" />
				</div>
				<UiPageHeader class="flex-1" :title="topic.name" :description="topic.description">
					<template #meta>
						<div class="flex items-center flex-wrap gap-4 text-sm text-text-tertiary">
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:users" class="w-4 h-4" />
								<span>{{
									t(
										'dashboard.audience.topics.detail.index.contactCount',
										{ count: topic.contactCount },
										topic.contactCount
									)
								}}</span>
							</div>
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:calendar" class="w-4 h-4" />
								<span>{{
									t('dashboard.audience.topics.detail.index.createdOn', {
										date: formatDate(topic.createdAt),
									})
								}}</span>
							</div>
							<div
								v-if="topic.requireDoubleOptIn"
								class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-brand/10 text-brand"
							>
								<Icon name="lucide:shield" class="w-3.5 h-3.5" />
								<span>{{ t('dashboard.audience.topics.detail.index.doiRequired') }}</span>
							</div>
						</div>
					</template>
				</UiPageHeader>
			</div>

			<!-- Search Bar -->
			<div class="mb-6">
				<div class="relative max-w-md">
					<Icon
						name="lucide:search"
						class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
					/>
					<input
						v-model="searchQuery"
						type="text"
						:placeholder="t('dashboard.audience.topics.detail.index.searchPlaceholder')"
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
					<p class="text-text-secondary font-medium">
						{{ t('dashboard.audience.topics.detail.index.empty.title') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						{{ t('dashboard.audience.topics.detail.index.empty.body') }}
					</p>
					<UiButton to="/dashboard/audience/contacts" class="gap-2 mt-6">
						{{ t('dashboard.audience.topics.detail.index.empty.action') }}
					</UiButton>
				</div>

				<!-- Empty State (no search results) -->
				<div
					v-else-if="!contactsLoading && filteredContacts.length === 0 && debouncedSearch"
					class="flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">
						{{ t('dashboard.audience.topics.detail.index.noResults.title') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						{{
							t('dashboard.audience.topics.detail.index.noResults.body', { query: debouncedSearch })
						}}
					</p>
					<UiButton
						variant="secondary"
						class="mt-6"
						@click="
							searchQuery = '';
							debouncedSearch = '';
						"
					>
						{{ t('dashboard.audience.topics.detail.index.clearSearch') }}
					</UiButton>
				</div>

				<!-- Data Table -->
				<div v-else>
					<!-- Card list below md. The two are alternatives, not layers: a
					     CSS-only switch would keep both copies of every row in the DOM. -->
					<ul v-if="!tableFits" class="divide-y divide-border-subtle">
						<li
							v-for="contact in paginatedContacts"
							:key="contact._id"
							class="flex items-center gap-1 px-4 py-2"
						>
							<button
								type="button"
								class="flex-1 min-w-0 text-left py-1"
								@click="viewContact(contact._id)"
							>
								<span class="block text-text-primary font-medium truncate">{{ contact.email }}</span>
								<span
									v-if="contact.firstName || contact.lastName"
									class="block text-sm text-text-secondary truncate"
								>
									{{ [contact.firstName, contact.lastName].filter(Boolean).join(' ') }}
								</span>
								<span class="block text-xs text-text-tertiary mt-0.5">
									{{ formatDate(contact.addedAt) }}
								</span>
							</button>
							<button
								class="w-11 h-11 flex items-center justify-center flex-shrink-0 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors"
								:aria-label="t('dashboard.audience.topics.detail.index.removeFromTopic')"
								@click="openRemoveModal(contact)"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</button>
						</li>
					</ul>

					<div v-else class="overflow-x-auto">
						<table class="w-full">
							<thead>
								<tr class="border-b border-border-subtle">
									<th
										class="text-left px-6 py-4 text-sm font-medium text-text-secondary cursor-pointer hover:text-text-primary transition-colors"
										@click="handleSort('email')"
									>
										<div class="flex items-center gap-1">
											{{ t('common.email') }}
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
											{{ t('dashboard.audience.topics.detail.index.table.firstName') }}
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
											{{ t('dashboard.audience.topics.detail.index.table.lastName') }}
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
											{{ t('dashboard.audience.topics.detail.index.table.added') }}
											<Icon
												v-if="getSortIcon('addedAt')"
												:name="getSortIcon('addedAt')!"
												class="w-4 h-4"
											/>
										</div>
									</th>
									<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
										{{ t('common.actions') }}
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
												:title="t('dashboard.audience.topics.detail.index.removeFromTopic')"
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
						<p class="text-sm text-text-tertiary">
							{{
								t('dashboard.audience.topics.detail.index.showing.label', { range: showingRange })
							}}
						</p>

						<div class="flex items-center gap-1">
							<button
								class="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50 disabled:pointer-events-none transition-colors"
								:disabled="!canGoPrev"
								@click="goToPage(currentPage - 1)"
								:aria-label="t('dashboard.audience.topics.detail.index.pagination.previous')"
							>
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>

							<template v-for="(page, index) in pageNumbers" :key="index">
								<span v-if="page === '...'" class="px-2 text-text-tertiary"> ... </span>
								<button
									v-else
									:class="[
										'min-w-[32px] h-8 px-2 rounded-lg text-sm font-medium transition-colors',
										page === currentPage
											? 'bg-text-primary text-text-inverse'
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
								:aria-label="t('dashboard.audience.topics.detail.index.pagination.next')"
							>
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
			:title="t('dashboard.audience.topics.detail.index.removeDialog.title')"
			:description="
				t('dashboard.audience.topics.detail.index.removeDialog.description', {
					email: removeTarget?.email ?? '',
					topic: topic?.name ?? '',
				})
			"
			:confirm-text="t('common.remove')"
			:is-loading="isRemoving"
			@update:open="
				(v: boolean) => {
					if (!v) closeRemoveModal();
				}
			"
			@confirm="handleRemove"
		/>
	</div>
</template>
