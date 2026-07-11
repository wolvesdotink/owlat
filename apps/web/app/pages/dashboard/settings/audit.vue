<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Audit Logs — Owlat' });

// Type for audit log entry
interface AuditLogEntry {
	_id: Id<'auditLogs'>;
	_creationTime: number;
	userId: string;
	action: string;
	resource: string;
	resourceId?: string;
	// The backend stores `details` as a jsonPrimitiveRecord (a plain object),
	// not a JSON string — do NOT JSON.parse it.
	details?: Record<string, unknown>;
	ipAddress?: string;
	userAgent?: string;
	createdAt: number;
	userProfile: {
		_id: Id<'userProfiles'>;
		name?: string;
		email: string;
	} | null;
}

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
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
} = useOrganizationQuery(api.auditLogs.list, () => ({
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
const { data: activeUsersData } = useOrganizationQuery(api.auditLogs.getActiveUsers);

// Get stats for the stats cards
const { data: statsData } = useOrganizationQuery(api.auditLogs.getStats, () => ({
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
		const actionLabel = getActionLabel(log.action).toLowerCase();
		const resourceLabel = getResourceLabel(log.resource).toLowerCase();
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
const {
	resourceTypes,
	actionTypeGroups,
	getResourceIcon,
	getResourceLabel,
	getActionLabel,
	getActionIcon,
	getActionColorClass,
	formatTimestamp,
	formatFullDate,
	parseDetails,
	getUserInitials,
} = useAuditLogPresentation();

// Date range options
const dateRangeOptions = [
	{ value: 'all', label: 'All Time' },
	{ value: 'today', label: 'Last 24 Hours' },
	{ value: 'week', label: 'Last 7 Days' },
	{ value: 'month', label: 'Last 30 Days' },
];
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
					<h1 class="text-2xl font-semibold text-text-primary">Audit Log</h1>
					<p class="mt-1 text-text-secondary">Track all team member actions and changes</p>
				</div>
			</div>
		</div>

		<!-- Admins-only gate (audit trail is privileged) -->
		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Admins only</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				The audit log is available to workspace owners and admins only.
			</p>
		</div>

		<UiQueryBoundary
			v-else
			:loading="isLoading && accumulatedLogs.length === 0"
			:error="auditLogsError"
			error-title="Couldn't load the audit log"
			loading-label="Loading audit log..."
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
			<div
				v-if="!hasActiveOrganization"
				class="card flex flex-col items-center justify-center py-16 text-center px-6"
			>
				<UiIconBox
					icon="lucide:clipboard-list"
					size="xl"
					variant="surface"
					rounded="full"
					class="mb-4"
				/>
				<p class="text-text-secondary font-medium">No workspace selected</p>
				<p class="text-sm text-text-tertiary mt-1 max-w-sm">
					Create or select a workspace to view the audit log.
				</p>
			</div>

			<!-- Content -->
			<div v-else class="space-y-6">
				<!-- Stats Cards -->
				<div v-if="statsData" class="grid grid-cols-2 md:grid-cols-4 gap-4">
					<div class="card p-4">
						<p class="text-sm text-text-secondary">Total Actions</p>
						<p class="text-2xl font-semibold text-text-primary mt-1">{{ statsData.total }}</p>
					</div>
					<div class="card p-4">
						<div class="flex items-center gap-2">
							<Icon name="lucide:send" class="w-4 h-4 text-brand" />
							<p class="text-sm text-text-secondary">Campaigns</p>
						</div>
						<p class="text-2xl font-semibold text-text-primary mt-1">
							{{ statsData.byResource['campaign'] ?? 0 }}
						</p>
					</div>
					<div class="card p-4">
						<div class="flex items-center gap-2">
							<Icon name="lucide:users" class="w-4 h-4 text-brand" />
							<p class="text-sm text-text-secondary">Contacts</p>
						</div>
						<p class="text-2xl font-semibold text-text-primary mt-1">
							{{ statsData.byResource['contact'] ?? 0 }}
						</p>
					</div>
					<div class="card p-4">
						<div class="flex items-center gap-2">
							<Icon name="lucide:settings" class="w-4 h-4 text-warning" />
							<p class="text-sm text-text-secondary">Settings</p>
						</div>
						<p class="text-2xl font-semibold text-text-primary mt-1">
							{{ statsData.byResource['settings'] ?? 0 }}
						</p>
					</div>
				</div>

				<!-- Filters -->
				<div class="card p-4">
					<div class="flex flex-col lg:flex-row gap-4">
						<!-- Search -->
						<div class="relative flex-1">
							<Icon
								name="lucide:search"
								class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary"
							/>
							<input
								v-model="searchQuery"
								type="text"
								placeholder="Search by user, action, or details..."
								class="input pl-10"
							/>
						</div>

						<!-- Resource Filter -->
						<div class="flex items-center gap-2">
							<Icon name="lucide:filter" class="w-4 h-4 text-text-tertiary" />
							<select v-model="selectedResource" class="input w-40">
								<option
									v-for="resource in resourceTypes"
									:key="resource.value"
									:value="resource.value"
								>
									{{ resource.label }}
								</option>
							</select>
						</div>

						<!-- Action Filter -->
						<div class="flex items-center gap-2">
							<Icon name="lucide:activity" class="w-4 h-4 text-text-tertiary" />
							<select v-model="selectedAction" class="input w-44">
								<option value="">All Actions</option>
								<optgroup v-for="group in actionTypeGroups" :key="group.label" :label="group.label">
									<option
										v-for="actionValue in group.actions"
										:key="actionValue"
										:value="actionValue"
									>
										{{ getActionLabel(actionValue) }}
									</option>
								</optgroup>
							</select>
						</div>

						<!-- User Filter -->
						<div
							v-if="activeUsersData && activeUsersData.length > 0"
							class="flex items-center gap-2"
						>
							<Icon name="lucide:user" class="w-4 h-4 text-text-tertiary" />
							<select v-model="selectedUserId" class="input w-40">
								<option value="">All Users</option>
								<option v-for="user in activeUsersData" :key="user._id" :value="user.authUserId">
									{{ user.name ?? user.email }}
								</option>
							</select>
						</div>

						<!-- Date Range Filter -->
						<div class="flex items-center gap-2">
							<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
							<select v-model="dateRange" class="input w-40">
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
						<button
							v-if="
								searchQuery ||
								selectedAction ||
								selectedResource ||
								selectedUserId ||
								dateRange !== 'all'
							"
							class="btn btn-ghost gap-2 text-text-secondary hover:text-text-primary"
							@click="resetFilters"
						>
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
							Reset
						</button>
					</div>
				</div>

				<!-- Empty State -->
				<div
					v-if="auditLogsData && auditLogsData.logs.length === 0"
					class="card flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox
						icon="lucide:clipboard-list"
						size="xl"
						variant="surface"
						rounded="full"
						class="mb-4"
					/>
					<p class="text-text-secondary font-medium">No activity recorded</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						Team actions will appear here as they happen. Start by creating a campaign, adding
						contacts, or updating settings.
					</p>
				</div>

				<!-- No Search Results -->
				<div
					v-else-if="filteredLogs.length === 0 && searchQuery.trim()"
					class="card flex flex-col items-center justify-center py-16 text-center px-6"
				>
					<UiIconBox icon="lucide:search" size="xl" variant="surface" rounded="full" class="mb-4" />
					<p class="text-text-secondary font-medium">No results found</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm">
						No audit logs match "{{ searchQuery }}". Try a different search term or adjust filters.
					</p>
				</div>

				<!-- Audit Log List -->
				<div v-else-if="filteredLogs.length > 0" class="space-y-4">
					<div
						v-for="log in filteredLogs"
						:key="log._id"
						class="card p-4 hover:bg-bg-surface/30 transition-colors"
					>
						<div class="flex items-start gap-4">
							<!-- User Avatar -->
							<div class="flex-shrink-0">
								<div
									class="w-10 h-10 rounded-full bg-bg-surface flex items-center justify-center text-sm font-medium text-text-secondary"
								>
									{{ getUserInitials(log.userProfile?.name, log.userProfile?.email) }}
								</div>
							</div>

							<!-- Content -->
							<div class="flex-1 min-w-0">
								<div class="flex items-center flex-wrap gap-2 mb-1">
									<!-- User Name -->
									<span class="font-medium text-text-primary">
										{{ log.userProfile?.name ?? log.userProfile?.email ?? 'Unknown User' }}
									</span>

									<!-- Action Badge -->
									<span
										:class="[
											'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
											getActionColorClass(log.action),
										]"
									>
										<Icon :name="getActionIcon(log.action)" class="w-3 h-3" />
										{{ getActionLabel(log.action) }}
									</span>

									<!-- Resource Badge -->
									<span
										class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary"
									>
										<Icon :name="getResourceIcon(log.resource)" class="w-3 h-3" />
										{{ getResourceLabel(log.resource) }}
									</span>
								</div>

								<!-- Details -->
								<div v-if="log.details" class="text-sm text-text-secondary mt-1">
									<template v-if="parseDetails(log.details)['name']">
										<span class="font-medium">"{{ parseDetails(log.details)['name'] }}"</span>
									</template>
									<template v-else-if="parseDetails(log.details)['email']">
										<span class="font-medium">{{ parseDetails(log.details)['email'] }}</span>
									</template>
									<template v-else-if="parseDetails(log.details)['count']">
										<span class="font-medium">{{ parseDetails(log.details)['count'] }} items</span>
									</template>
								</div>

								<!-- Timestamp -->
								<p class="text-xs text-text-tertiary mt-2" :title="formatFullDate(log.createdAt)">
									{{ formatTimestamp(log.createdAt) }}
								</p>
							</div>

							<!-- Resource Icon -->
							<div class="flex-shrink-0">
								<div class="p-2 rounded-lg bg-bg-surface flex items-center justify-center">
									<Icon :name="getResourceIcon(log.resource)" class="w-4 h-4 text-text-secondary" />
								</div>
							</div>
						</div>
					</div>

					<!-- Load More -->
					<div v-if="auditLogsData?.hasMore" class="flex justify-center pt-4">
						<button class="btn btn-secondary gap-2" @click="loadMore">
							<Icon name="lucide:chevron-down" class="w-4 h-4" />
							Load More
						</button>
					</div>
				</div>
			</div>
		</UiQueryBoundary>
	</div>
</template>
