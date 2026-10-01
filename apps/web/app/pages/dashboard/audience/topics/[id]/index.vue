<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.topics.detail.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Breadcrumbs
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();

// Get the topic ID from the route
const topicId = useRouteId<'topics'>();

// Get the current user's organization (organizationLoading used for loading state)
const { isLoading: organizationLoading } = useOrganizationContext();
// Removing a contact from a topic requires `topics:manage` (owner/admin) —
// `apps/api/convex/topics/topics.ts`. Reading the membership does not.
const { can } = usePermissions();
const canManage = computed(() => can('topics:manage'));

// Fetch topic details
const {
	data: topic,
	isLoading: topicLoading,
	error: topicError,
	refetch: refetchTopic,
} = useConvexQuery(api.topics.topics.get, () => ({
	topicId: topicId.value,
}));

// Fetch contacts in this topic (paginated)
const contactsPage = usePaginatedQuery(
	api.topics.topics.getContacts,
	() => ({ topicId: topicId.value }),
	{ initialNumItems: 50 }
);
const contactsLoading = contactsPage.isLoading;
const contactsError = contactsPage.error;

const isLoading = computed(
	() => organizationLoading.value || topicLoading.value || contactsLoading.value
);

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

// Search, sort and paging over the loaded contacts (client-side), pulling more
// server pages as the user nears the end or searches. Newest members first.
const contacts = reactive(
	useMemberTable({
		paginated: contactsPage,
		dateField: 'addedAt',
		defaultSort: 'addedAt',
		loadMoreSize: 50,
	})
);
const contactPath = (contact: { _id: Id<'contacts'> }) =>
	`/dashboard/audience/topics/${topicId.value}/contacts/${contact._id}`;

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
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- A failed read is not a missing topic (#721). -->
		<UiQueryBoundary v-if="topicError" :error="topicError" @retry="refetchTopic" />

		<!-- Loading State -->
		<DashboardDetailSkeleton
			v-else-if="isLoading && !topic"
			:label="t('dashboard.audience.topics.detail.index.loading')"
			back="button"
			lead="tile"
			meta
			body="table"
		/>

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

			<AudienceMemberTable
				v-model:search="contacts.searchQuery"
				:rows="contacts.pageRows"
				date-field="addedAt"
				:row-to="contactPath"
				:active-search="contacts.debouncedSearch"
				:search-placeholder="t('dashboard.audience.topics.detail.index.searchPlaceholder')"
				:loading="contactsLoading"
				:error="contactsError"
				:empty="{
					icon: 'lucide:users',
					title: t('dashboard.audience.topics.detail.index.empty.title'),
					description: t('dashboard.audience.topics.detail.index.empty.body'),
				}"
				:is-sortable="contacts.isSortable"
				:get-sort-icon="contacts.getSortIcon"
				:current-page="contacts.currentPage"
				:total-pages="contacts.totalPages"
				:page-numbers="contacts.pageNumbers"
				:showing-range="contacts.showingRange"
				@sort="contacts.toggleSort"
				@page="contacts.goToPage"
				@clear-search="contacts.clearSearch"
				@retry="contactsPage.refetch"
			>
				<template #empty-action>
					<UiButton to="/dashboard/audience/contacts">
						{{ t('dashboard.audience.topics.detail.index.empty.action') }}
					</UiButton>
				</template>
				<template v-if="canManage" #row-actions="{ row, layout }">
					<button
						type="button"
						:class="[
							'flex items-center justify-center flex-shrink-0 rounded-lg text-text-tertiary hover:text-error hover:bg-error-subtle transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
							layout === 'card' ? 'w-11 h-11' : 'p-2',
						]"
						:title="t('dashboard.audience.topics.detail.index.removeFromTopic')"
						:aria-label="t('dashboard.audience.topics.detail.index.removeFromTopic')"
						@click="openRemoveModal(row)"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
				</template>
			</AudienceMemberTable>
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
