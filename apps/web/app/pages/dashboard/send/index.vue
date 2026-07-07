<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Templates & blocks — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

// Fetch template counts
const {
	data: templateCounts,
	isLoading: countsLoading,
	error: countsError,
} = useOrganizationQuery(api.emailTemplates.organization.countByTypeByOrganization);

// Fetch recently edited templates
const {
	data: recentTemplates,
	isLoading: templatesLoading,
	error: templatesError,
} = useOrganizationQuery(api.emailTemplates.organization.getRecentByOrganization, { limit: 5 });

// Fetch blocks stats
const {
	data: blocksStats,
	isLoading: blocksStatsLoading,
	error: blocksStatsError,
} = useOrganizationQuery(api.emailBlocks.blocks.getStatsByTeam);

// Fetch recent blocks
const {
	data: recentBlocks,
	isLoading: blocksLoading,
	error: blocksError,
} = useOrganizationQuery(api.emailBlocks.blocks.getRecentByTeam, { limit: 3 });

// Stats for display
const stats = computed(() => [
	{
		label: 'Total Templates',
		value: templateCounts.value?.['total'] ?? 0,
		icon: 'lucide:mail',
	},
	{
		label: 'Marketing',
		value: templateCounts.value?.['marketing'] ?? 0,
		icon: 'lucide:megaphone',
	},
	{
		label: 'Transactional',
		value: templateCounts.value?.['transactional'] ?? 0,
		icon: 'lucide:file-code',
	},
	{
		label: 'Saved Blocks',
		value: blocksStats.value?.total ?? 0,
		icon: 'lucide:layout-grid',
	},
]);

// Quick actions
const quickActions = [
	{
		label: 'Marketing Emails',
		href: '/dashboard/send/marketing',
		icon: 'lucide:megaphone',
		description: 'Create a newsletter or promotional email',
	},
	{
		label: 'Transactional Emails',
		href: '/dashboard/send/transactional',
		icon: 'lucide:file-code',
		description: 'Create an API-triggered email',
	},
	{
		label: 'Browse Blocks',
		href: '/dashboard/send/blocks',
		icon: 'lucide:layout-grid',
		description: 'View and manage saved blocks',
	},
	{
		label: 'Media',
		href: '/dashboard/send/media',
		icon: 'lucide:image',
		description: 'Upload and manage images',
	},
	{
		label: 'Files',
		href: '/dashboard/files',
		icon: 'lucide:file-search',
		description: 'Browse uploaded files',
	},
];

// Get type badge color
function getTypeBadgeClass(type: string): string {
	return type === 'marketing' ? 'bg-brand-subtle text-brand' : 'bg-lavender-subtle text-lavender';
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-8">
			<h1 class="text-2xl font-semibold text-text-primary">Templates &amp; blocks</h1>
			<p class="mt-1 text-text-secondary">Manage your email templates and reusable blocks.</p>
		</div>

		<!-- Stats Cards -->
		<UiErrorAlert
			v-if="countsError || templatesError || blocksStatsError || blocksError"
			message="Some mail data couldn't be loaded. Reload the page to try again."
			class="mb-8"
		/>
		<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
			<div
				v-for="stat in stats"
				:key="stat.label"
				class="card group hover:border-border-default transition-colors"
			>
				<div class="flex items-start justify-between">
					<div>
						<p class="text-sm text-text-secondary">{{ stat.label }}</p>
						<div class="flex items-center gap-2 mt-1">
							<p
								v-if="countsLoading || blocksStatsLoading"
								class="text-3xl font-semibold text-text-tertiary"
							>
								--
							</p>
							<p v-else class="text-3xl font-semibold text-text-primary">
								{{ stat.value }}
							</p>
							<Icon
								v-if="countsLoading || blocksStatsLoading"
								name="lucide:loader-2"
								class="w-4 h-4 animate-spin text-text-tertiary"
							/>
						</div>
					</div>
					<UiIconBox :icon="stat.icon" />
				</div>
			</div>
		</div>

		<!-- Quick Actions -->
		<div class="mb-8">
			<h2 class="text-lg font-semibold text-text-primary mb-4">Quick Actions</h2>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<NuxtLink
					v-for="action in quickActions"
					:key="action.label"
					:to="action.href"
					class="card group hover:border-brand transition-colors cursor-pointer"
				>
					<div class="flex items-center gap-4">
						<UiIconBox
							:icon="action.icon"
							class="group-hover:bg-brand group-hover:text-text-inverse transition-colors"
						/>
						<div>
							<p class="font-medium text-text-primary group-hover:text-brand transition-colors">
								{{ action.label }}
							</p>
							<p class="text-sm text-text-tertiary">{{ action.description }}</p>
						</div>
					</div>
				</NuxtLink>
			</div>
		</div>

		<!-- Two column layout for recent items -->
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
			<!-- Recently Edited Templates -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary">Recently Edited</h2>
					<NuxtLink
						to="/dashboard/send/marketing"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						View all
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="templatesLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!recentTemplates || recentTemplates.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<UiIconBox
							icon="lucide:file-text"
							size="xl"
							variant="surface"
							rounded="full"
							class="mb-4"
						/>
						<p class="text-text-secondary font-medium">No templates yet</p>
						<p class="text-sm text-text-tertiary mt-1 max-w-sm">
							Create your first email template to get started.
						</p>
						<NuxtLink to="/dashboard/send/marketing" class="btn btn-primary mt-6 gap-2">
							<Icon name="lucide:plus" class="w-4 h-4" />
							Create Template
						</NuxtLink>
					</div>

					<!-- Templates list -->
					<div v-else class="divide-y divide-border-subtle">
						<NuxtLink
							v-for="template in recentTemplates"
							:key="template._id"
							:to="`/dashboard/send/emails/${template._id}/edit`"
							class="flex items-center gap-4 py-3 first:pt-0 last:pb-0 hover:bg-bg-surface -mx-4 px-4 transition-colors"
						>
							<UiIconBox icon="lucide:mail" size="sm" variant="surface" rounded="lg" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate font-medium">
									{{ template.name }}
								</p>
								<div class="flex items-center gap-2 mt-0.5">
									<span
										:class="['text-xs px-1.5 py-0.5 rounded', getTypeBadgeClass(template.type)]"
									>
										{{ template.type }}
									</span>
									<span class="text-xs text-text-tertiary flex items-center gap-1">
										<Icon name="lucide:clock" class="w-3 h-3" />
										{{ formatCompactRelativeTime(template.updatedAt) }}
									</span>
								</div>
							</div>
						</NuxtLink>
					</div>
				</div>
			</div>

			<!-- Saved Blocks -->
			<div>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-text-primary">Saved Blocks</h2>
					<NuxtLink
						to="/dashboard/send/blocks"
						class="text-sm text-brand hover:text-brand-hover flex items-center gap-1"
					>
						View all
						<Icon name="lucide:arrow-right" class="w-3 h-3" />
					</NuxtLink>
				</div>
				<div class="card">
					<!-- Loading state -->
					<div v-if="blocksLoading" class="flex items-center justify-center py-8">
						<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
					</div>

					<!-- Empty state -->
					<div
						v-else-if="!recentBlocks || recentBlocks.length === 0"
						class="flex flex-col items-center justify-center py-12 text-center"
					>
						<UiIconBox
							icon="lucide:layout-grid"
							size="xl"
							variant="surface"
							rounded="full"
							class="mb-4"
						/>
						<p class="text-text-secondary font-medium">No blocks saved</p>
						<p class="text-sm text-text-tertiary mt-1 max-w-sm">
							Save reusable blocks from your email editor to use across templates.
						</p>
					</div>

					<!-- Blocks list -->
					<div v-else class="divide-y divide-border-subtle">
						<div
							v-for="block in recentBlocks"
							:key="block._id"
							class="flex items-center gap-4 py-3 first:pt-0 last:pb-0"
						>
							<UiIconBox icon="lucide:layout-grid" size="sm" variant="surface" rounded="lg" />
							<div class="flex-1 min-w-0">
								<p class="text-sm text-text-primary truncate font-medium">
									{{ block.name }}
								</p>
								<div class="flex items-center gap-2 mt-0.5">
									<span
										v-if="block.blockCount && block.blockCount > 1"
										class="text-xs px-1.5 py-0.5 rounded bg-brand/10 text-brand"
									>
										{{ block.blockCount }} blocks
									</span>
									<span class="text-xs text-text-tertiary">
										Used {{ block.usageCount }} times
									</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
