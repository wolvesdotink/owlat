<script setup lang="ts">
import { api } from '@owlat/api';
import type { AuditLogEntry } from '~/composables/useAuditLogPresentation';
import {
	ActivityIcon,
	CalendarIcon,
	ClipboardListIcon,
	FilterIcon,
	LockIcon,
	PaperPlaneIcon,
	ReloadIcon,
	SearchIcon,
	SettingsIcon,
	UserIcon,
	UsersIcon,
} from '@coolicons/vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.audit.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// The audit trail is a privileged surface — only owners/admins should see it.
// Show an "Admins only" state for editors instead of the full log.
const { showAdminGate } = usePermissions();

// Filter state
const searchQuery = ref('');
const selectedAction = ref<string>('');
const selectedResource = ref<string>('');
const selectedUserId = ref<string>('');
const dateRange = ref<'all' | 'today' | 'week' | 'month'>('all');

// Pagination
const cursor = ref<string | null>(null);
const pageSize = 25;

// Compute date range values
const dateRangeValues = computed(() => {
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;

	switch (dateRange.value) {
		case 'today':
			return {
				startDate: now - dayMs,
				endDate: now,
			};
		case 'week':
			return {
				startDate: now - 7 * dayMs,
				endDate: now,
			};
		case 'month':
			return {
				startDate: now - 30 * dayMs,
				endDate: now,
			};
		default:
			return {
				startDate: undefined,
				endDate: undefined,
			};
	}
});

// Get audit logs with real-time updates
const {
	data: auditLogsData,
	isLoading: auditLogsLoading,
	error: auditLogsError,
	refetch: refetchAuditLogs,
} = useOrganizationQuery(api.auditActions.logs.list, () => ({
	action: selectedAction.value || undefined,
	resource: selectedResource.value || undefined,
	userId: selectedUserId.value || undefined,
	startDate: dateRangeValues.value.startDate,
	endDate: dateRangeValues.value.endDate,
	limit: pageSize,
	cursor: cursor.value ?? undefined,
}));

// Accumulate pages so "Load More" appends instead of replacing the visible
// page (first page replaces, each next appends deduped by _id); a filter/date
// change resets to a fresh first page so the by_created_at cursor is never
// reused across filters. See useAccumulatedCursorList.
const cursorPage = computed(() => {
	const data = auditLogsData.value;
	if (!data) return null;
	return {
		items: data.logs as AuditLogEntry[],
		nextCursor: data.nextCursor,
		hasMore: data.hasMore,
	};
});
const {
	accumulated: accumulatedLogs,
	loadMore,
	reset: resetAccumulated,
} = useAccumulatedCursorList(cursorPage, cursor, [
	selectedAction,
	selectedResource,
	selectedUserId,
	dateRange,
]);

// Get active users for the filter dropdown
const { data: activeUsersData } = useOrganizationQuery(api.auditActions.logs.getActiveUsers);

// Get stats for the stats cards
const { data: statsData } = useOrganizationQuery(api.auditActions.logs.getStats, () => ({
	startDate: dateRangeValues.value.startDate,
	endDate: dateRangeValues.value.endDate,
}));

const isLoading = computed(() => organizationLoading.value || auditLogsLoading.value);

// Filtered logs based on search
const filteredLogs = computed((): AuditLogEntry[] => {
	if (accumulatedLogs.value.length === 0) return [];
	if (!searchQuery.value.trim()) return accumulatedLogs.value;

	const query = searchQuery.value.toLowerCase().trim();
	return accumulatedLogs.value.filter((log: AuditLogEntry) => {
		const details = log.details ?? {};
		const userName = log.userProfile?.name?.toLowerCase() ?? '';
		const userEmail = log.userProfile?.email?.toLowerCase() ?? '';
		const actionLabel = t(getActionLabel(log.action)).toLowerCase();
		const resourceLabel = t(getResourceLabel(log.resource)).toLowerCase();
		const detailsStr = JSON.stringify(details).toLowerCase();

		return (
			userName.includes(query) ||
			userEmail.includes(query) ||
			actionLabel.includes(query) ||
			resourceLabel.includes(query) ||
			detailsStr.includes(query)
		);
	});
});

const resetFilters = () => {
	searchQuery.value = '';
	selectedAction.value = '';
	selectedResource.value = '';
	selectedUserId.value = '';
	dateRange.value = 'all';
	resetAccumulated();
};

// Presentation tables + the action-filter catalog (the latter derived from the
// backend AUDIT_ACTION_LITERALS SSOT so it cannot drift). See
// useAuditLogPresentation.
const { resourceTypes, actionTypeGroups, getResourceLabel, getActionLabel } =
	useAuditLogPresentation();

// Date range options
const dateRangeOptions = computed(() => [
	{ value: 'all', label: t('dashboard.admin.team.audit.dateRange.all') },
	{ value: 'today', label: t('dashboard.admin.team.audit.dateRange.today') },
	{ value: 'week', label: t('dashboard.admin.team.audit.dateRange.week') },
	{ value: 'month', label: t('dashboard.admin.team.audit.dateRange.month') },
]);

// The counters say how much happened, not what to do about it, so they stay
// collapsed and the filters and the log lead the page.
const showStats = ref(false);
</script>

<template>
	<div>
		<UiPageHeader
			class="mb-6"
			:title="t('dashboard.admin.team.audit.title')"
			:description="t('dashboard.admin.team.audit.subtitle')"
		/>

		<!-- Admins-only gate (audit trail is privileged) -->
		<div v-if="showAdminGate" class="card">
			<UiEmptyState
				:icon="LockIcon"
				:title="t('dashboard.admin.team.audit.adminGate.title')"
				:description="t('dashboard.admin.team.audit.adminGate.description')"
			/>
		</div>

		<UiQueryBoundary
			v-else
			:loading="isLoading && accumulatedLogs.length === 0"
			:error="auditLogsError"
			@retry="refetchAuditLogs"
			:error-title="t('dashboard.admin.team.audit.errorTitle')"
		>
			<!-- First-load skeleton (shaped like the audit-log table). Gated on the
			     accumulated rows, not the raw page: a Load More briefly resets
			     auditLogsData to undefined while the next page resubscribes, but page 1
			     stays in accumulatedLogs, so the rows never blank back to the skeleton
			     mid-session. A filter change clears accumulatedLogs synchronously, so it
			     still shows the first-load skeleton as intended. -->
			<template #loading>
				<div class="card overflow-hidden">
					<DashboardListSkeleton variant="table" :columns="5" :rows="8" />
				</div>
			</template>

			<!-- No Organization State -->
			<div v-if="!hasActiveOrganization" class="card">
				<UiEmptyState
					:icon="ClipboardListIcon"
					:title="t('dashboard.admin.team.audit.noWorkspace.title')"
					:description="t('dashboard.admin.team.audit.noWorkspace.description')"
				/>
			</div>

			<!-- Content -->
			<div v-else class="space-y-6">
				<!-- Stats: counters of what happened, one click away. -->
				<UiDisclosure
					v-if="statsData"
					v-model="showStats"
					:label="t('dashboard.admin.team.audit.stats.summary')"
				>
					<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
						<div class="card p-4">
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.team.audit.stats.totalActions') }}
							</p>
							<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
								{{ statsData.total }}
							</p>
						</div>
						<div class="card p-4">
							<div class="flex items-center gap-2">
								<PaperPlaneIcon class="w-4 h-4 text-brand" />
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.team.audit.stats.campaigns') }}
								</p>
							</div>
							<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
								{{ statsData.byResource['campaign'] ?? 0 }}
							</p>
						</div>
						<div class="card p-4">
							<div class="flex items-center gap-2">
								<UsersIcon class="w-4 h-4 text-brand" />
								<p class="text-sm text-text-secondary">
									{{ t('dashboard.admin.team.audit.stats.contacts') }}
								</p>
							</div>
							<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
								{{ statsData.byResource['contact'] ?? 0 }}
							</p>
						</div>
						<div class="card p-4">
							<div class="flex items-center gap-2">
								<SettingsIcon class="w-4 h-4 text-warning" />
								<p class="text-sm text-text-secondary">{{ t('common.settings') }}</p>
							</div>
							<p class="text-2xl font-medium tracking-[-0.02em] text-text-primary mt-1">
								{{ statsData.byResource['settings'] ?? 0 }}
							</p>
						</div>
					</div>
				</UiDisclosure>

				<!-- Filters. The search takes its own row and the selects wrap below it:
				     in one `lg:flex-row` line inside the settings column the search
				     collapsed to an icon-wide box and the last select ran out of the card
				     (German labels). -->
				<div class="card p-4">
					<div class="flex flex-wrap items-center gap-x-4 gap-y-3">
						<!-- Search -->
						<div class="relative w-full">
							<SearchIcon
								class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
							/>
							<input
								v-model="searchQuery"
								type="text"
								:placeholder="t('dashboard.admin.team.audit.searchPlaceholder')"
								:aria-label="t('dashboard.admin.team.audit.filters.search')"
								class="input pl-10"
							/>
						</div>

						<!-- Resource Filter -->
						<div class="flex items-center gap-2">
							<FilterIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
							<select
								v-model="selectedResource"
								class="input w-40"
								:aria-label="t('dashboard.admin.team.audit.filters.resource')"
							>
								<option
									v-for="resource in resourceTypes"
									:key="resource.value"
									:value="resource.value"
								>
									{{ t(resource.label) }}
								</option>
							</select>
						</div>

						<!-- Action Filter -->
						<div class="flex items-center gap-2">
							<ActivityIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
							<select
								v-model="selectedAction"
								class="input w-44"
								:aria-label="t('dashboard.admin.team.audit.filters.action')"
							>
								<option value="">{{ t('dashboard.admin.team.audit.allActions') }}</option>
								<optgroup
									v-for="group in actionTypeGroups"
									:key="group.label"
									:label="t(group.label)"
								>
									<option
										v-for="actionValue in group.actions"
										:key="actionValue"
										:value="actionValue"
									>
										{{ t(getActionLabel(actionValue)) }}
									</option>
								</optgroup>
							</select>
						</div>

						<!-- User Filter -->
						<div
							v-if="activeUsersData && activeUsersData.length > 0"
							class="flex items-center gap-2"
						>
							<UserIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
							<select
								v-model="selectedUserId"
								class="input w-40"
								:aria-label="t('dashboard.admin.team.audit.filters.user')"
							>
								<option value="">{{ t('dashboard.admin.team.audit.allUsers') }}</option>
								<option v-for="user in activeUsersData" :key="user._id" :value="user.authUserId">
									{{ user.name ?? user.email }}
								</option>
							</select>
						</div>

						<!-- Date Range Filter -->
						<div class="flex items-center gap-2">
							<CalendarIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
							<select
								v-model="dateRange"
								class="input w-44"
								:aria-label="t('dashboard.admin.team.audit.filters.dateRange')"
							>
								<option
									v-for="option in dateRangeOptions"
									:key="option.value"
									:value="option.value"
								>
									{{ option.label }}
								</option>
							</select>
						</div>

						<!-- Reset Filters -->
						<UiButton
							variant="ghost"
							v-if="
								searchQuery ||
								selectedAction ||
								selectedResource ||
								selectedUserId ||
								dateRange !== 'all'
							"
							class="gap-2 text-text-secondary hover:text-text-primary"
							@click="resetFilters"
						>
							<ReloadIcon class="w-4 h-4" />
							{{ t('dashboard.admin.team.audit.resetFilters') }}
						</UiButton>
					</div>
				</div>

				<!-- Empty State -->
				<div v-if="auditLogsData && auditLogsData.logs.length === 0" class="card">
					<UiEmptyState
						:icon="ClipboardListIcon"
						:title="t('dashboard.admin.team.audit.empty.title')"
						:description="t('dashboard.admin.team.audit.empty.description')"
					/>
				</div>

				<!-- No Search Results -->
				<!-- Search runs over the pages loaded so far. While older pages remain,
				     say so and keep Load more here, or a match on a later page could
				     never be reached while the search is active. -->
				<div v-else-if="filteredLogs.length === 0 && searchQuery.trim()" class="card">
					<UiEmptyState
						variant="no-results"
						:icon="SearchIcon"
						:title="t('dashboard.admin.team.audit.noResults.title')"
						:description="
							auditLogsData?.hasMore
								? t('dashboard.admin.team.audit.noResults.loadedOnly', { query: searchQuery })
								: t('dashboard.admin.team.audit.noResults.description', { query: searchQuery })
						"
					>
						<template #action>
							<UiButton v-if="auditLogsData?.hasMore" variant="secondary" @click="loadMore">
								{{ t('components.dashboard.auditLogList.loadMore') }}
							</UiButton>
							<UiButton v-else variant="secondary" @click="resetFilters">
								{{ t('dashboard.admin.team.audit.resetFilters') }}
							</UiButton>
						</template>
					</UiEmptyState>
				</div>

				<!-- Audit Log List -->
				<DashboardAuditLogList
					v-else-if="filteredLogs.length > 0"
					:logs="filteredLogs"
					:has-more="auditLogsData?.hasMore ?? false"
					@load-more="loadMore"
				/>
			</div>
		</UiQueryBoundary>
	</div>
</template>
