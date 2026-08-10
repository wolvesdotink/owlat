<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Administration — Owlat' });
definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

const { level, reason } = useDeliveryHealth();
const deliveryLabel = computed(() => {
	if (level.value === 'error') return 'Sending needs attention';
	if (level.value === 'warn') return 'Sending needs a review';
	return 'Sending is healthy';
});
const deliveryTone = computed(() =>
	level.value === 'error' ? 'text-error' : level.value === 'warn' ? 'text-warning' : 'text-success'
);

const areas = [
	{
		title: 'Delivery',
		description: 'Sending health, domains, transport, routing, and webhooks.',
		href: '/dashboard/admin/delivery',
		icon: 'lucide:truck',
	},
	{
		title: 'Team & access',
		description: 'Members, shared inboxes, approved senders, API keys, and connected apps.',
		href: '/dashboard/admin/team',
		icon: 'lucide:users-round',
	},
	{
		title: 'Instance',
		description: 'Workspace defaults, operating mode, features, AI, channels, and plugins.',
		href: '/dashboard/admin/instance',
		icon: 'lucide:server-cog',
	},
] as const;

// Operator tooling and deployment maintenance are scoped to this deployment's
// platform admin (each destination also carries the `platform-admin` route
// middleware), so the group only appears for them — same gate the old Settings
// hub used, and the same note for everyone else explaining the absence.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);

const platformAreas = [
	{
		title: 'Operator console',
		description: 'Review held content, workspace sending status, and platform admins.',
		href: '/dashboard/admin/operator',
		icon: 'lucide:shield-alert',
	},
	{
		title: 'System & updates',
		description: 'Stack version, container health, and in-app updates.',
		href: '/dashboard/admin/system',
		icon: 'lucide:cpu',
	},
	{
		title: 'Backups',
		description: 'Schedule daily backups, run one now, and find the restore command.',
		href: '/dashboard/admin/backups',
		icon: 'lucide:database-backup',
	},
] as const;
</script>

<template>
	<div class="p-6 lg:p-8 max-w-6xl">
		<header class="mb-8">
			<p class="text-sm font-medium text-brand mb-1">Administration</p>
			<h1 class="text-3xl font-semibold text-text-primary">Your instance at a glance</h1>
			<p class="mt-2 text-text-secondary max-w-2xl">
				Start with the verdicts here. Detailed configuration and operator tools are one level deeper
				when you need them.
			</p>
		</header>

		<NuxtLink
			to="/dashboard/admin/delivery"
			class="card block mb-6 border-l-4 border-l-brand hover:bg-bg-surface transition-colors"
		>
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-4">
					<UiIconBox icon="lucide:activity" size="md" variant="surface" rounded="lg" />
					<div>
						<p class="text-sm text-text-tertiary">Delivery verdict</p>
						<h2 class="text-xl font-semibold" :class="deliveryTone">{{ deliveryLabel }}</h2>
						<p v-if="reason" class="mt-1 text-sm text-text-secondary">{{ reason }}</p>
					</div>
				</div>
				<Icon name="lucide:arrow-right" class="w-5 h-5 text-text-tertiary mt-2" />
			</div>
		</NuxtLink>

		<div class="grid gap-4 md:grid-cols-3">
			<NuxtLink v-for="area in areas" :key="area.href" :to="area.href" class="group">
				<UiCard hoverable class="h-full">
					<UiIconBox :icon="area.icon" size="md" variant="surface" rounded="lg" />
					<h2 class="mt-4 text-lg font-semibold text-text-primary">{{ area.title }}</h2>
					<p class="mt-1 text-sm text-text-secondary">{{ area.description }}</p>
					<span class="mt-5 inline-flex items-center gap-1 text-sm font-medium text-brand">
						Open <Icon name="lucide:arrow-right" class="w-4 h-4" />
					</span>
				</UiCard>
			</NuxtLink>
		</div>

		<!-- Platform: deployment-level tooling, platform admin only -->
		<section v-if="isPlatformAdmin === true" class="mt-10">
			<h2 class="mb-4 text-lg font-semibold text-text-primary">Platform</h2>
			<div class="grid gap-4 md:grid-cols-3">
				<NuxtLink v-for="area in platformAreas" :key="area.href" :to="area.href" class="group">
					<UiCard hoverable class="h-full">
						<div class="flex items-start gap-3">
							<UiIconBox :icon="area.icon" size="sm" variant="surface" rounded="lg" />
							<div>
								<h3 class="font-semibold text-text-primary">{{ area.title }}</h3>
								<p class="mt-1 text-sm text-text-secondary">{{ area.description }}</p>
							</div>
						</div>
					</UiCard>
				</NuxtLink>
			</div>
		</section>

		<!-- Everyone else: explain what is missing and who holds it -->
		<div
			v-else-if="isPlatformAdmin === false"
			class="mt-10 flex items-start gap-3 rounded-lg border border-border-subtle bg-bg-surface p-4"
		>
			<Icon name="lucide:shield" class="w-5 h-5 shrink-0 mt-0.5 text-text-tertiary" />
			<p class="text-sm text-text-secondary">
				Operator tools, system updates, and backups are held by this deployment's platform admin and
				aren't shown here.
				<a
					href="https://docs.owlat.app/developer/self-hosting-maintenance"
					target="_blank"
					rel="noopener"
					class="text-brand hover:underline whitespace-nowrap"
				>
					Learn more →
				</a>
			</p>
		</div>
	</div>
</template>
