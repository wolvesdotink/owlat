<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.index.pageTitle') });
definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] });

// `level` is null until the roll-up answers, and the verdict is the loudest
// claim on this page — so it renders a placeholder rather than "Sending is
// healthy" over a send path nothing has checked yet.
const { level, reason } = useDeliveryHealth();
const deliveryLabel = computed(() => {
	if (level.value === 'error') return t('dashboard.admin.index.verdict.error');
	if (level.value === 'warn') return t('dashboard.admin.index.verdict.warn');
	return t('dashboard.admin.index.verdict.ok');
});
const deliveryTone = computed(() =>
	level.value === 'error' ? 'text-error' : level.value === 'warn' ? 'text-warning' : 'text-success'
);

const areas = computed(() => [
	{
		title: t('dashboard.admin.index.areas.delivery.title'),
		description: t('dashboard.admin.index.areas.delivery.description'),
		href: '/dashboard/admin/delivery',
		icon: 'lucide:truck',
	},
	{
		title: t('dashboard.admin.index.areas.team.title'),
		description: t('dashboard.admin.index.areas.team.description'),
		href: '/dashboard/admin/team',
		icon: 'lucide:users-round',
	},
	{
		title: t('dashboard.admin.index.areas.instance.title'),
		description: t('dashboard.admin.index.areas.instance.description'),
		href: '/dashboard/admin/instance',
		icon: 'lucide:server-cog',
	},
]);

// Operator tooling and deployment maintenance are scoped to this deployment's
// platform admin (each destination also carries the `platform-admin` route
// middleware), so the group only appears for them — same gate the old Settings
// hub used, and the same note for everyone else explaining the absence.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);

const platformAreas = computed(() => [
	{
		title: t('dashboard.admin.index.platformAreas.operator.title'),
		description: t('dashboard.admin.index.platformAreas.operator.description'),
		href: '/dashboard/admin/operator',
		icon: 'lucide:shield-alert',
	},
	{
		title: t('dashboard.admin.index.platformAreas.system.title'),
		description: t('dashboard.admin.index.platformAreas.system.description'),
		href: '/dashboard/admin/system',
		icon: 'lucide:cpu',
	},
	{
		title: t('dashboard.admin.index.platformAreas.backups.title'),
		description: t('dashboard.admin.index.platformAreas.backups.description'),
		href: '/dashboard/admin/backups',
		icon: 'lucide:database-backup',
	},
]);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-6xl">
		<header class="mb-8">
			<p class="lp-eyebrow mb-1">{{ t('dashboard.admin.index.eyebrow') }}</p>
			<h1 class="text-3xl font-semibold text-text-primary">
				{{ t('dashboard.admin.index.title') }}
			</h1>
			<p class="mt-2 text-text-secondary max-w-2xl">
				{{ t('dashboard.admin.index.lede') }}
			</p>
		</header>

		<NuxtLink
			to="/dashboard/admin/delivery"
			class="card block mb-6 hover:bg-bg-surface transition-colors"
		>
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-start gap-4">
					<UiIconBox icon="lucide:activity" size="md" variant="surface" rounded="lg" />
					<div>
						<p class="text-sm text-text-tertiary">
							{{ t('dashboard.admin.index.deliveryVerdict') }}
						</p>
						<h2 v-if="level" class="text-xl font-semibold" :class="deliveryTone">
							{{ deliveryLabel }}
						</h2>
						<UiSkeleton v-else class="mt-1 h-6 w-52" />
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
					<span
						class="mt-5 inline-flex items-center gap-1 text-sm font-medium text-text-secondary group-hover:text-text-primary transition-colors duration-(--motion-fast)"
					>
						{{ t('common.open') }} <Icon name="lucide:arrow-right" class="w-4 h-4" />
					</span>
				</UiCard>
			</NuxtLink>
		</div>

		<!-- Platform: deployment-level tooling, platform admin only -->
		<section v-if="isPlatformAdmin === true" class="mt-10">
			<h2 class="mb-4 text-lg font-semibold text-text-primary">
				{{ t('dashboard.admin.index.platform') }}
			</h2>
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
				{{ t('dashboard.admin.index.platformAdminOnly') }}
				<a
					href="https://docs.owlat.app/developer/self-hosting-maintenance"
					target="_blank"
					rel="noopener"
					class="text-brand hover:underline whitespace-nowrap"
				>
					{{ t('dashboard.admin.index.learnMore') }}
				</a>
			</p>
		</div>
	</div>
</template>
