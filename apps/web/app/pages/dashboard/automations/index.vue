<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Automations — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Keyboard shortcuts
const { registerNewShortcut, registerEscapeHandler, unregisterShortcut } = useKeyboardShortcuts();

onMounted(() => {
	// 'n' to create new automation
	registerNewShortcut(() => {
		if (!isDeleteModalOpen.value) {
			router.push('/dashboard/automations/new');
		}
	});

	// Escape to close delete modal
	registerEscapeHandler(() => {
		if (isDeleteModalOpen.value && !isDeleting.value) {
			closeDeleteModal();
		}
	});
});

onUnmounted(() => {
	unregisterShortcut('n');
	unregisterShortcut('escape');
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: teamLoading } = useOrganizationContext();
const router = useRouter();

// Status filter state
type AutomationStatus = 'all' | 'draft' | 'active' | 'paused';
const selectedStatus = ref<AutomationStatus>('all');

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

// Status filter options
const statusFilters: { value: AutomationStatus; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'active', label: 'Active' },
	{ value: 'paused', label: 'Paused' },
	{ value: 'draft', label: 'Draft' },
];

// Fetch automations with real-time updates (session-based, no organizationId needed).
// Status filtering runs server-side through the Listing engine (ADR-0037).
const { results: automations, isLoading: automationsLoading } = usePaginatedQuery(
	api.automations.automations.list,
	() => ({
		status: selectedStatus.value === 'all' ? undefined : selectedStatus.value,
	}),
	{ initialNumItems: 100 }
);

// Client-side search filtering
const filteredAutomations = computed(() => {
	if (!automations.value) return [];
	if (!debouncedSearch.value) return automations.value;

	const search = debouncedSearch.value.toLowerCase();
	return automations.value.filter(
		(automation) =>
			automation.name.toLowerCase().includes(search) ||
			(automation.description && automation.description.toLowerCase().includes(search))
	);
});

// Fetch automation counts by status
const { data: statusCounts } = useOrganizationQuery(api.automations.automations.countByStatus);

const isLoading = computed(() => teamLoading.value || automationsLoading.value);

// Mutations
const { run: duplicateAutomation } = useBackendOperation(api.automations.automations.duplicate, {
	label: 'Duplicate automation',
});
const { run: deleteAutomation } = useBackendOperation(api.automations.automations.remove, {
	label: 'Delete automation',
});
const { run: pauseAutomation } = useBackendOperation(api.automations.automations.pause, {
	label: 'Pause automation',
});
const { run: resumeAutomation } = useBackendOperation(api.automations.automations.resume, {
	label: 'Resume automation',
});

// Get trigger type display
const getTriggerDisplay = (
	triggerType: 'contact_created' | 'contact_updated' | 'event_received' | 'topic_subscribed'
) => {
	switch (triggerType) {
		case 'contact_created':
			return { label: 'Contact Created', icon: 'lucide:user-plus' };
		case 'contact_updated':
			return { label: 'Contact Updated', icon: 'lucide:user-cog' };
		case 'event_received':
			return { label: 'Event Received', icon: 'lucide:radio' };
		case 'topic_subscribed':
			return { label: 'Subscribed to Topic', icon: 'lucide:list-plus' };
	}
};

// Get status badge configuration
const getStatusBadge = (status: 'draft' | 'active' | 'paused') => {
	switch (status) {
		case 'draft':
			return {
				color: 'bg-text-tertiary/10 text-text-tertiary',
				icon: 'lucide:pencil',
				label: 'Draft',
			};
		case 'active':
			return { color: 'bg-success/10 text-success', icon: 'lucide:play', label: 'Active' };
		case 'paused':
			return { color: 'bg-warning/10 text-warning', icon: 'lucide:pause', label: 'Paused' };
	}
};

// Action dropdown state
const openDropdownId = ref<Id<'automations'> | null>(null);

const toggleDropdown = (id: Id<'automations'>) => {
	openDropdownId.value = openDropdownId.value === id ? null : id;
};

// Close dropdown when clicking outside
useClickOutsideSelector('[data-dropdown]', () => {
	openDropdownId.value = null;
});

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Toggle active/paused status
const toggleingId = ref<Id<'automations'> | null>(null);

const handleToggleStatus = async (automation: {
	_id: Id<'automations'>;
	status: 'draft' | 'active' | 'paused';
	name: string;
}) => {
	// Re-entrancy guard: ignore repeat clicks while a toggle is already running
	// (the inline button and the dropdown item both call this).
	if (toggleingId.value) return;
	if (automation.status === 'draft') {
		// Cannot toggle draft, must edit first
		showNotification('Please complete and activate this automation from the builder', 'error');
		return;
	}

	toggleingId.value = automation._id;
	try {
		if (automation.status === 'active') {
			if ((await pauseAutomation({ automationId: automation._id })) === undefined) return;
			showNotification(`"${automation.name}" has been paused`);
		} else {
			if ((await resumeAutomation({ automationId: automation._id })) === undefined) return;
			showNotification(`"${automation.name}" is now active`);
		}
		openDropdownId.value = null;
	} finally {
		toggleingId.value = null;
	}
};

// Handle duplicate
const handleDuplicate = async (automationId: Id<'automations'>) => {
	const result = await duplicateAutomation({ automationId });
	if (result === undefined) return;
	showNotification('Automation duplicated successfully');
	openDropdownId.value = null;
};

// Delete confirmation modal
const isDeleteModalOpen = ref(false);
const automationToDelete = ref<{
	id: Id<'automations'>;
	name: string;
	status: 'draft' | 'active' | 'paused';
} | null>(null);
const isDeleting = ref(false);

const openDeleteModal = (
	id: Id<'automations'>,
	name: string,
	status: 'draft' | 'active' | 'paused'
) => {
	automationToDelete.value = { id, name, status };
	isDeleteModalOpen.value = true;
	openDropdownId.value = null;
};

const closeDeleteModal = () => {
	isDeleteModalOpen.value = false;
	automationToDelete.value = null;
};

const handleDelete = async () => {
	if (!automationToDelete.value) return;

	isDeleting.value = true;
	try {
		const result = await deleteAutomation({ automationId: automationToDelete.value.id });
		if (result === undefined) return;
		showNotification('Automation deleted successfully');
		closeDeleteModal();
	} finally {
		isDeleting.value = false;
	}
};

// Navigate to automation builder
const handleNewAutomation = () => {
	router.push('/dashboard/automations/new');
};

// Navigate to edit automation
const handleEdit = (automationId: Id<'automations'>) => {
	router.push(`/dashboard/automations/${automationId}/edit`);
};

// Navigate to automation detail/analytics
const handleViewDetails = (automationId: Id<'automations'>) => {
	router.push(`/dashboard/automations/${automationId}`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Automations</h1>
				<p class="mt-1 text-text-secondary">Create automated email workflows triggered by events</p>
			</div>
			<UiButton size="sm" @click="handleNewAutomation">
				<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
				New Automation
			</UiButton>
		</div>

		<!-- Filters and Search -->
		<div class="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
			<!-- Status Filters -->
			<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
				<button
					v-for="filter in statusFilters"
					:key="filter.value"
					:class="[
						'px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5',
						selectedStatus === filter.value
							? 'bg-bg-elevated text-text-primary shadow-sm'
							: 'text-text-secondary hover:text-text-primary',
					]"
					@click="selectedStatus = filter.value"
				>
					{{ filter.label }}
					<span v-if="statusCounts" class="text-xs text-text-tertiary">
						({{ filter.value === 'all' ? statusCounts['total'] : statusCounts[filter.value] }})
					</span>
				</button>
			</div>

			<div class="flex-1" />

			<!-- Search -->
			<UiInput
				v-model="searchQuery"
				type="text"
				placeholder="Search automations..."
				size="sm"
				class="w-64"
			>
				<template #iconLeft>
					<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
				</template>
			</UiInput>
		</div>

		<!-- Content -->
		<div>
			<!-- Loading State -->
			<div v-if="isLoading && !automations" class="flex items-center justify-center py-16">
				<div class="flex flex-col items-center gap-3">
					<UiSpinner />
					<p class="text-text-secondary text-sm">Loading automations...</p>
				</div>
			</div>

			<!-- Empty State (no team) -->
			<UiEmptyState
				v-else-if="!hasActiveOrganization"
				icon="lucide:zap"
				title="No team selected"
				description="Create or select a team to start creating automations."
			/>

			<!-- Empty State (no automations) -->
			<UiEmptyState
				v-else-if="
					!isLoading &&
					(!filteredAutomations || filteredAutomations.length === 0) &&
					!debouncedSearch
				"
				icon="lucide:zap"
				title="No automations yet"
				description="Create your first automation to send emails automatically when a contact signs up, subscribes, or triggers an event."
			>
				<template #action>
					<UiButton @click="handleNewAutomation">
						<template #iconLeft><Icon name="lucide:plus" class="w-4 h-4" /></template>
						Create Automation
					</UiButton>
				</template>
			</UiEmptyState>

			<!-- Empty State (no search results) -->
			<UiEmptyState
				v-else-if="
					!isLoading &&
					(!filteredAutomations || filteredAutomations.length === 0) &&
					debouncedSearch
				"
				icon="lucide:search"
				title="No results found"
				:description="`No automations match &quot;${debouncedSearch}&quot;. Try a different search term.`"
			>
				<template #action>
					<UiButton
						variant="secondary"
						@click="
							searchQuery = '';
							debouncedSearch = '';
						"
					>
						Clear search
					</UiButton>
				</template>
			</UiEmptyState>

			<!-- Automations Table -->
			<div v-else class="card p-0 overflow-hidden">
				<div class="overflow-x-auto">
					<table class="w-full">
						<thead>
							<tr class="border-b border-border-subtle">
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Name</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Trigger</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Status</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">
									Contacts in Flow
								</th>
								<th class="text-left px-6 py-4 text-sm font-medium text-text-secondary">Created</th>
								<th class="text-right px-6 py-4 text-sm font-medium text-text-secondary">
									Actions
								</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="automation in filteredAutomations"
								:key="automation._id"
								class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface transition-colors"
							>
								<td class="px-6 py-4">
									<div class="min-w-0">
										<span
											class="text-text-primary font-medium hover:text-brand cursor-pointer transition-colors"
											@click="
												automation.status === 'draft'
													? handleEdit(automation._id)
													: handleViewDetails(automation._id)
											"
										>
											{{ automation.name }}
										</span>
										<p
											v-if="automation.description"
											class="text-sm text-text-tertiary truncate mt-0.5 max-w-xs"
										>
											{{ automation.description }}
										</p>
									</div>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center gap-1.5">
										<Icon
											:name="getTriggerDisplay(automation.triggerType).icon"
											class="w-4 h-4 text-text-tertiary"
										/>
										<span class="text-text-secondary text-sm">
											{{ getTriggerDisplay(automation.triggerType).label }}
										</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span
										:class="[
											'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
											getStatusBadge(automation.status).color,
										]"
									>
										<Icon :name="getStatusBadge(automation.status).icon" class="w-3 h-3" />
										{{ getStatusBadge(automation.status).label }}
									</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center gap-1.5">
										<Icon name="lucide:users" class="w-4 h-4 text-text-tertiary" />
										<span class="text-text-secondary text-sm">
											{{ automation.statsActive || 0 }}
										</span>
									</div>
								</td>
								<td class="px-6 py-4">
									<span class="text-text-secondary text-sm">
										{{ formatDate(automation.createdAt) }}
									</span>
								</td>
								<td class="px-6 py-4">
									<div class="flex items-center justify-end gap-1" @click.stop>
										<!-- Toggle Active/Paused -->
										<button
											v-if="automation.status !== 'draft'"
											:class="[
												'p-2 rounded-lg transition-colors',
												automation.status === 'active'
													? 'text-warning hover:text-warning hover:bg-warning/10'
													: 'text-success hover:text-success hover:bg-success/10',
											]"
											:title="automation.status === 'active' ? 'Pause' : 'Activate'"
											:disabled="toggleingId === automation._id"
											@click="handleToggleStatus(automation)"
										>
											<Icon
												v-if="toggleingId === automation._id"
												name="lucide:loader-2"
												class="w-4 h-4 animate-spin"
											/>
											<Icon
												v-else-if="automation.status === 'active'"
												name="lucide:pause"
												class="w-4 h-4"
											/>
											<Icon v-else name="lucide:play" class="w-4 h-4" />
										</button>
										<!-- Edit -->
										<button
											class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
											title="Edit"
											@click="handleEdit(automation._id)"
										>
											<Icon name="lucide:pencil" class="w-4 h-4" />
										</button>
										<!-- More Actions Dropdown -->
										<div class="relative" data-dropdown>
											<button
												class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
												@click="toggleDropdown(automation._id)"
												aria-label="More actions"
											>
												<Icon name="lucide:more-vertical" class="w-4 h-4" />
											</button>
											<Transition
												enter-active-class="duration-(--motion-moderate) ease-spring"
												enter-from-class="opacity-0 scale-95"
												enter-to-class="opacity-100 scale-100"
												leave-active-class="duration-(--motion-moderate-exit) ease-exit"
												leave-from-class="opacity-100 scale-100"
												leave-to-class="opacity-0 scale-95"
											>
												<div
													v-if="openDropdownId === automation._id"
													class="absolute right-0 top-full mt-1 w-40 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg z-10 py-1"
												>
													<button
														v-if="automation.status !== 'draft'"
														class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
														@click="handleViewDetails(automation._id)"
													>
														<Icon name="lucide:zap" class="w-4 h-4" />
														View Details
													</button>
													<button
														class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
														@click="handleEdit(automation._id)"
													>
														<Icon name="lucide:pencil" class="w-4 h-4" />
														Edit
													</button>
													<button
														class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
														@click="handleDuplicate(automation._id)"
													>
														<Icon name="lucide:copy" class="w-4 h-4" />
														Duplicate
													</button>
													<button
														v-if="automation.status !== 'draft'"
														:disabled="toggleingId === automation._id"
														class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
														@click="handleToggleStatus(automation)"
													>
														<Icon
															:name="
																automation.status === 'active' ? 'lucide:pause' : 'lucide:play'
															"
															class="w-4 h-4"
														/>
														{{ automation.status === 'active' ? 'Pause' : 'Activate' }}
													</button>
													<div
														v-if="automation.status !== 'active'"
														class="border-t border-border-subtle my-1"
													/>
													<button
														v-if="automation.status !== 'active'"
														class="w-full px-3 py-2 text-left text-sm text-error hover:bg-error/10 flex items-center gap-2 transition-colors"
														@click="
															openDeleteModal(automation._id, automation.name, automation.status)
														"
													>
														<Icon name="lucide:trash-2" class="w-4 h-4" />
														Delete
													</button>
												</div>
											</Transition>
										</div>
									</div>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>

		<!-- Delete Confirmation Modal -->
		<UiModal
			:open="isDeleteModalOpen"
			title="Delete Automation"
			size="md"
			:closable="!isDeleting"
			:persistent="isDeleting"
			@update:open="
				(v) => {
					if (!v) closeDeleteModal();
				}
			"
		>
			<div class="flex items-start gap-4">
				<div class="p-3 rounded-full bg-error/10 shrink-0 flex items-center justify-center">
					<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
				</div>
				<div>
					<p class="text-text-primary">
						Are you sure you want to delete
						<span class="font-semibold">"{{ automationToDelete?.name }}"</span>?
					</p>
					<p class="text-sm text-text-secondary mt-2">
						This action cannot be undone. The automation and all its steps will be permanently
						deleted.
					</p>
					<p
						v-if="automationToDelete?.status === 'active'"
						class="text-sm text-warning mt-2 flex items-center gap-1.5"
					>
						<Icon name="lucide:alert-circle" class="w-4 h-4" />
						Active automations must be paused before deletion.
					</p>
				</div>
			</div>

			<template #footer>
				<button class="btn btn-secondary" :disabled="isDeleting" @click="closeDeleteModal">
					Cancel
				</button>
				<button
					class="btn bg-error text-white hover:bg-error/90 gap-2"
					:disabled="isDeleting || automationToDelete?.status === 'active'"
					@click="handleDelete"
				>
					<Icon v-if="isDeleting" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
					{{ isDeleting ? 'Deleting...' : 'Delete Automation' }}
				</button>
			</template>
		</UiModal>
	</div>
</template>
