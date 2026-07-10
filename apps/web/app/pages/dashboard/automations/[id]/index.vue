<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id, Doc } from '@owlat/api/dataModel';
import { stepEditorModuleFor, type StepKind } from '~/composables/automations/steps';

useHead({ title: 'Automation Details — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const automationId = computed(() => route.params['id'] as Id<'automations'>);

// Fetch automation with related data
const { data: automation, isLoading: automationLoading } = useConvexQuery(
	api.automations.automations.getWithRelations,
	() => ({ automationId: automationId.value })
);

// Fetch automation stats
const { data: stats, isLoading: statsLoading } = useConvexQuery(
	api.automations.analytics.getAutomationStats,
	() => ({ automationId: automationId.value })
);

// Fetch step analytics for funnel
const { data: stepAnalytics } = useConvexQuery(api.automations.analytics.getStepAnalytics, () => ({
	automationId: automationId.value,
}));

// Pagination state for contacts list
const pageSize = 10;
const runsOffset = ref(0);
const selectedRunStatus = ref<'all' | 'running' | 'completed' | 'cancelled'>('all');

// Fetch automation runs (contacts in automation)
const { data: runs, isLoading: runsLoading } = useConvexQuery(
	api.automations.analytics.getAutomationRuns,
	() => ({
		automationId: automationId.value,
		status: selectedRunStatus.value === 'all' ? undefined : selectedRunStatus.value,
		limit: pageSize,
		offset: runsOffset.value,
	})
);

const isLoading = computed(() => automationLoading.value || statsLoading.value);

// Status + trigger badges (shared with the automations overview)
const { getStatusBadge, getTriggerDisplay } = useAutomationBadges();

// Get run status badge configuration
const getRunStatusBadge = (status: 'running' | 'completed' | 'cancelled') => {
	switch (status) {
		case 'running':
			return {
				color: 'bg-brand/10 text-brand',
				icon: 'lucide:loader-2',
				label: 'In Progress',
				animated: true,
			};
		case 'completed':
			return {
				color: 'bg-success/10 text-success',
				icon: 'lucide:check-circle-2',
				label: 'Completed',
				animated: false,
			};
		case 'cancelled':
			return {
				color: 'bg-error/10 text-error',
				icon: 'lucide:x-circle',
				label: 'Cancelled',
				animated: false,
			};
	}
};

// Email templates joined onto each step by getWithRelations (enrichForQuery),
// so an email step's label resolves to the real template name instead of
// "Unknown Template".
const stepEmailTemplates = computed<Doc<'emailTemplates'>[]>(() => {
	const steps = (automation.value?.steps ?? []) as Array<Record<string, unknown>>;
	return steps
		.map((s) => s['emailTemplate'])
		.filter((t): t is Doc<'emailTemplates'> => !!t && typeof t === 'object');
});

// Step label — resolved through the step editor module's getDescription.
// `parseConfig` throws on malformed input; we fall back to the bare label.
const getStepLabel = (stepType: StepKind, config: string | Record<string, unknown>) => {
	const module = stepEditorModuleFor(stepType);
	try {
		const raw = typeof config === 'string' ? JSON.parse(config) : config;
		return (
			module.getDescription as (
				c: unknown,
				ctx: { emailTemplates: Doc<'emailTemplates'>[] }
			) => string
		)(module.parseConfig(raw), { emailTemplates: stepEmailTemplates.value });
	} catch {
		return module.label;
	}
};

// Step icon — resolved through the step editor module registry.
const stepInfo = (stepType: string) => {
	const module = stepEditorModuleFor(stepType as StepKind);
	return { icon: module.icon, label: module.label };
};

// Page-local accent palette per step kind for the funnel rows. The edit
// page uses a different palette; both pages own their own STEP_ACCENT
// rather than smearing a shared color across modules that don't need it.
type FunnelAccent = {
	readonly iconBg: string;
	readonly iconText: string;
	readonly barBg: string;
};

const STEP_ACCENT: Readonly<Record<StepKind, FunnelAccent>> = {
	email: { iconBg: 'bg-warning/10', iconText: 'text-warning', barBg: 'bg-warning/20' },
	delay: { iconBg: 'bg-brand/10', iconText: 'text-brand', barBg: 'bg-brand/20' },
	condition: {
		iconBg: 'bg-text-tertiary/10',
		iconText: 'text-text-tertiary',
		barBg: 'bg-text-tertiary/20',
	},
};

const stepAccent = (stepType: string): FunnelAccent => STEP_ACCENT[stepType as StepKind];

// Calculate funnel percentages
const getFunnelPercentage = (
	stepStats: { total: number; completed: number },
	totalEntered: number
) => {
	if (totalEntered === 0) return 0;
	return Math.round((stepStats.completed / totalEntered) * 100);
};

// Stats cards configuration
const statsCards = computed(() => {
	if (!stats.value) return [];
	return [
		{
			label: 'Contacts Entered',
			value: stats.value.totalEntered,
			icon: 'lucide:users',
			color: 'text-brand',
			bgColor: 'bg-brand/10',
		},
		{
			label: 'Active',
			value: stats.value.running,
			icon: 'lucide:loader-2',
			color: 'text-brand',
			bgColor: 'bg-brand/10',
		},
		{
			label: 'Completed',
			value: stats.value.completed,
			icon: 'lucide:user-check',
			color: 'text-success',
			bgColor: 'bg-success/10',
		},
		{
			label: 'Emails Sent',
			value: stats.value.emailsSent,
			icon: 'lucide:mail',
			color: 'text-warning',
			bgColor: 'bg-warning/10',
		},
	];
});

// Pagination handlers
const loadMoreRuns = () => {
	if (runs.value?.hasMore) {
		runsOffset.value += pageSize;
	}
};

const loadPrevRuns = () => {
	if (runsOffset.value > 0) {
		runsOffset.value = Math.max(0, runsOffset.value - pageSize);
	}
};

// Reset offset when status filter changes
watch(selectedRunStatus, () => {
	runsOffset.value = 0;
});

// Navigate to edit
const handleEdit = () => {
	router.push(`/dashboard/automations/${automationId.value}/edit`);
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !automation" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading automation...</p>
			</div>
		</div>

		<!-- Automation Not Found -->
		<div
			v-else-if="!automation"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:zap" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Automation not found</p>
			<p class="text-sm text-text-tertiary mt-1">
				This automation may have been deleted or you don't have access to it.
			</p>
			<NuxtLink to="/dashboard/automations" class="btn btn-secondary mt-6">
				Back to Automations
			</NuxtLink>
		</div>

		<!-- Analytics Content -->
		<div v-else>
			<!-- Header -->
			<div class="mb-8">
				<NuxtLink
					to="/dashboard/automations"
					class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary text-sm mb-4 transition-colors"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					Back to Automations
				</NuxtLink>
				<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
					<div>
						<div class="flex items-center gap-3">
							<h1 class="text-2xl font-semibold text-text-primary">{{ automation.name }}</h1>
							<span
								:class="[
									'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
									getStatusBadge(automation.status).color,
								]"
							>
								<Icon :name="getStatusBadge(automation.status).icon" class="w-3 h-3" />
								{{ getStatusBadge(automation.status).label }}
							</span>
						</div>
						<p v-if="automation.description" class="mt-1 text-text-secondary">
							{{ automation.description }}
						</p>
						<div class="mt-2 flex items-center gap-4 text-sm text-text-tertiary">
							<div class="flex items-center gap-1.5">
								<Icon :name="getTriggerDisplay(automation.triggerType).icon" class="w-4 h-4" />
								{{ getTriggerDisplay(automation.triggerType).label }}
							</div>
							<div class="flex items-center gap-1.5">
								<Icon name="lucide:clock" class="w-4 h-4" />
								Created {{ formatDateTime(automation.createdAt) }}
							</div>
						</div>
					</div>
					<button class="btn btn-secondary gap-2" @click="handleEdit">
						<Icon name="lucide:pencil" class="w-4 h-4" />
						Edit Automation
					</button>
				</div>
			</div>

			<!-- Stats Cards -->
			<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
				<div v-for="stat in statsCards" :key="stat.label" class="card p-4">
					<div class="flex items-center gap-3 mb-3">
						<div :class="['p-2 rounded-lg', stat.bgColor]">
							<Icon :name="stat.icon" :class="['w-4 h-4', stat.color]" />
						</div>
						<span class="text-sm text-text-secondary">{{ stat.label }}</span>
					</div>
					<span class="text-2xl font-semibold text-text-primary">
						{{ stat.value.toLocaleString() }}
					</span>
				</div>
			</div>

			<!-- Completion Rate Card -->
			<div class="card p-6 mb-8">
				<div class="flex items-center justify-between mb-4">
					<h3 class="text-lg font-medium text-text-primary">Completion Rate</h3>
					<span class="text-3xl font-semibold text-brand">{{ stats?.completionRate || 0 }}%</span>
				</div>
				<UiProgressBar
					size="sm"
					:value="Math.min(stats?.completionRate || 0, 100)"
					aria-label="Automation completion rate"
				/>
				<p class="text-sm text-text-tertiary mt-3">
					{{ stats?.completed || 0 }} of {{ stats?.totalEntered || 0 }} contacts completed all steps
				</p>
			</div>

			<!-- Funnel Visualization -->
			<div class="card p-6 mb-8">
				<h3 class="text-lg font-medium text-text-primary mb-6">Step Funnel</h3>

				<!-- Empty state -->
				<div
					v-if="!stepAnalytics || stepAnalytics.length === 0"
					class="flex flex-col items-center justify-center py-12 text-center"
				>
					<Icon name="lucide:zap" class="w-12 h-12 text-text-tertiary mb-3" />
					<p class="text-text-secondary">No steps configured</p>
					<p class="text-sm text-text-tertiary mt-1">
						Add steps to your automation to see funnel analytics
					</p>
					<button class="btn btn-secondary mt-4" @click="handleEdit">Configure Steps</button>
				</div>

				<!-- Funnel chart -->
				<div v-else class="space-y-4">
					<!-- Trigger row -->
					<div class="flex items-center gap-4">
						<div class="w-24 shrink-0 text-right">
							<span class="text-xs text-text-tertiary uppercase tracking-wider">Trigger</span>
						</div>
						<div class="flex-1">
							<div class="flex items-center gap-3">
								<div :class="['p-2 rounded-lg', getTriggerDisplay(automation.triggerType).bgColor]">
									<Icon
										:name="getTriggerDisplay(automation.triggerType).icon"
										:class="['w-4 h-4', getTriggerDisplay(automation.triggerType).color]"
									/>
								</div>
								<div class="flex-1">
									<div
										class="h-8 bg-brand/20 rounded-lg flex items-center px-4"
										style="width: 100%"
									>
										<span class="text-sm font-medium text-text-primary">
											{{ stats?.totalEntered || 0 }} entered
										</span>
									</div>
								</div>
								<span class="w-16 text-right text-sm text-text-secondary">100%</span>
							</div>
						</div>
					</div>

					<!-- Connector -->
					<div class="flex items-center gap-4">
						<div class="w-24 shrink-0" />
						<div class="flex-1 flex justify-start pl-5">
							<div class="w-0.5 h-6 bg-border-subtle" />
						</div>
						<div class="w-16" />
					</div>

					<!-- Step rows -->
					<template v-for="(step, index) in stepAnalytics" :key="step.stepId">
						<div class="flex items-center gap-4">
							<div class="w-24 shrink-0 text-right">
								<span class="text-xs text-text-tertiary uppercase tracking-wider"
									>Step {{ index + 1 }}</span
								>
							</div>
							<div class="flex-1">
								<div class="flex items-center gap-3">
									<div :class="['p-2 rounded-lg', stepAccent(step.stepType).iconBg]">
										<Icon
											:name="stepInfo(step.stepType).icon"
											:class="['w-4 h-4', stepAccent(step.stepType).iconText]"
										/>
									</div>
									<div class="flex-1">
										<div
											class="h-8 rounded-lg flex items-center px-4 transition-all"
											:class="stepAccent(step.stepType).barBg"
											:style="{
												width: `${Math.max(getFunnelPercentage(step.stats, stats?.totalEntered || 0), 10)}%`,
											}"
										>
											<span class="text-sm font-medium text-text-primary truncate">
												{{ getStepLabel(step.stepType, step.config) }} ·
												{{ step.stats.completed }} completed
											</span>
										</div>
									</div>
									<span class="w-16 text-right text-sm text-text-secondary">
										{{ getFunnelPercentage(step.stats, stats?.totalEntered || 0) }}%
									</span>
								</div>
								<!-- Step details -->
								<div class="ml-11 mt-1 flex items-center gap-4 text-xs text-text-tertiary">
									<span v-if="step.stats.pending > 0" class="flex items-center gap-1">
										<Icon name="lucide:clock" class="w-3 h-3" />
										{{ step.stats.pending }} pending
									</span>
									<span v-if="step.stats.executing > 0" class="flex items-center gap-1">
										<Icon name="lucide:loader-2" class="w-3 h-3 animate-spin" />
										{{ step.stats.executing }} executing
									</span>
									<span v-if="step.stats.failed > 0" class="flex items-center gap-1 text-error">
										<Icon name="lucide:x-circle" class="w-3 h-3" />
										{{ step.stats.failed }} failed
									</span>
								</div>
							</div>
						</div>

						<!-- Connector between steps -->
						<div v-if="index < stepAnalytics.length - 1" class="flex items-center gap-4">
							<div class="w-24 shrink-0" />
							<div class="flex-1 flex justify-start pl-5">
								<div class="w-0.5 h-6 bg-border-subtle" />
							</div>
							<div class="w-16" />
						</div>
					</template>
				</div>
			</div>

			<!-- Contacts List -->
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle flex items-center justify-between">
					<h3 class="text-lg font-medium text-text-primary">Contacts in Automation</h3>
					<!-- Status filter -->
					<div class="flex items-center gap-1 p-1 bg-bg-surface rounded-lg">
						<button
							v-for="filter in [
								{ value: 'all' as const, label: 'All' },
								{ value: 'running' as const, label: 'In Progress' },
								{ value: 'completed' as const, label: 'Completed' },
								{ value: 'cancelled' as const, label: 'Cancelled' },
							]"
							:key="filter.value"
							:class="[
								'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
								selectedRunStatus === filter.value
									? 'bg-bg-elevated text-text-primary shadow-sm'
									: 'text-text-secondary hover:text-text-primary',
							]"
							@click="selectedRunStatus = filter.value"
						>
							{{ filter.label }}
						</button>
					</div>
				</div>

				<!-- Loading -->
				<div v-if="runsLoading && !runs" class="p-8 flex justify-center">
					<Icon name="lucide:loader-2" class="w-6 h-6 text-brand animate-spin" />
				</div>

				<!-- Empty state -->
				<div v-else-if="!runs || runs.runs.length === 0" class="py-12 text-center">
					<Icon name="lucide:users" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
					<p class="text-text-secondary">No contacts in this automation yet</p>
					<p class="text-sm text-text-tertiary mt-1">
						Contacts will appear here when the automation is triggered
					</p>
				</div>

				<!-- Contacts table -->
				<div v-else>
					<div class="divide-y divide-border-subtle">
						<div
							v-for="run in runs.runs"
							:key="run._id"
							class="px-6 py-4 flex items-center justify-between hover:bg-bg-surface transition-colors"
						>
							<div class="flex items-center gap-3 min-w-0">
								<UiIconBox icon="lucide:users" size="lg" rounded="full" />
								<div class="min-w-0">
									<div class="text-text-primary font-medium truncate">
										{{ run.contact?.firstName || run.contact?.email?.split('@')[0] || 'Unknown' }}
										{{ run.contact?.lastName || '' }}
									</div>
									<div class="text-sm text-text-tertiary truncate">
										{{ run.contact?.email || 'No email' }}
									</div>
								</div>
							</div>
							<div class="flex items-center gap-4 shrink-0">
								<div class="text-right">
									<span
										:class="[
											'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
											getRunStatusBadge(run.status).color,
										]"
									>
										<Icon
											:name="getRunStatusBadge(run.status).icon"
											:class="[
												'w-3 h-3',
												getRunStatusBadge(run.status).animated ? 'animate-spin' : '',
											]"
										/>
										{{ getRunStatusBadge(run.status).label }}
									</span>
									<div class="text-xs text-text-tertiary mt-1">
										Step {{ run.currentStepIndex + 1 }} ·
										{{ formatCompactRelativeTime(run.startedAt, { emptyLabel: '—' }) }}
									</div>
								</div>
								<NuxtLink
									v-if="run.contact"
									:to="`/dashboard/audience/contacts/${run.contact._id}`"
									class="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
									title="View contact"
								>
									<Icon name="lucide:chevron-right" class="w-4 h-4" />
								</NuxtLink>
							</div>
						</div>
					</div>

					<!-- Pagination -->
					<div
						v-if="runsOffset > 0 || runs.hasMore"
						class="px-6 py-4 border-t border-border-subtle flex items-center justify-between"
					>
						<button
							class="btn btn-secondary text-sm"
							:disabled="runsOffset === 0"
							@click="loadPrevRuns"
						>
							Previous
						</button>
						<span class="text-sm text-text-tertiary">
							{{ runsOffset + 1 }}–{{ runsOffset + (runs.runs?.length ?? 0) }}
						</span>
						<button
							class="btn btn-secondary text-sm"
							:disabled="!runs.hasMore"
							@click="loadMoreRuns"
						>
							Next
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
