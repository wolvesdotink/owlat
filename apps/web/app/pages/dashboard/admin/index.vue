<script setup lang="ts">
import { api } from '@owlat/api';
import {
	adminEntryFor,
	type AdminAreaKey,
	type AdminAttentionKey,
} from '~/lib/adminSettingsRegistry';
import { useWorkspaceSettingsNav } from '~/composables/useWorkspaceSettingsNav';

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

// The five Workspace groups, straight from the registry the Settings sidebar
// reads, each opening on its lead page. The System group already carries the
// platform-admin pages for whoever holds that role.
const { areas: registryAreas, badges } = useWorkspaceSettingsNav(ref(true));
const GROUP_ICONS: Record<AdminAreaKey, string> = {
	overview: 'lucide:gauge',
	team: 'lucide:users-round',
	delivery: 'lucide:truck',
	ai: 'lucide:sparkles',
	features: 'lucide:toggle-right',
	system: 'lucide:server-cog',
};
const groups = computed(() =>
	registryAreas.value
		.filter((area) => area.key !== 'overview' && area.entries.length > 0)
		.map((area) => ({
			key: area.key,
			title: t(area.titleKey),
			description: t(`dashboard.admin.index.groups.${area.key}`),
			href: area.entries[0]!.path,
			icon: GROUP_ICONS[area.key],
		}))
);

// Held or failed incoming mail: the one thing on the Workspace side that waits
// on a person. One line per list that has something in it, saying which list.
const ATTENTION_COPY: Record<AdminAttentionKey, string> = {
	quarantined: 'dashboard.admin.index.attentionQuarantined',
	failed: 'dashboard.admin.index.attentionFailed',
};
const attention = computed(() =>
	Object.entries(badges.value).flatMap(([href, count]) => {
		const entry = adminEntryFor(href);
		if (!entry?.attention) return [];
		return [{ href, count, icon: entry.icon, message: ATTENTION_COPY[entry.attention] }];
	})
);

// Operator tooling and deployment maintenance are scoped to this deployment's
// platform admin (each destination also carries the `platform-admin` route
// middleware). Everyone else gets a note explaining the absence, and an owner
// on an instance where nobody holds the role gets the claim below.
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => ({})
);

// One-time bootstrap: the roster is empty and the caller owns the org. Fresh
// installs never see this — `/seed/admin` grants the setup user their row — but
// an instance seeded before that shipped has nobody, and the alternative to a
// button here is asking the owner to `convex run` inside the container.
const { data: bootstrapStatus } = useConvexQuery(
	api.platformAdmin.bootstrap.getBootstrapStatus,
	() => ({})
);
const canClaimPlatformAdmin = computed(() => bootstrapStatus.value?.canClaim === true);

const { showToast } = useToast();
const { run: claimPlatformAdmin, isLoading: claiming } = useBackendOperation(
	api.platformAdmin.bootstrap.claimInitialPlatformAdmin,
	{ label: () => t('dashboard.admin.index.claimPlatform.operation') }
);

async function onClaimPlatformAdmin() {
	const r = await claimPlatformAdmin({});
	// Both queries above are live subscriptions, so the Platform group appears
	// on its own the moment the row lands — nothing to refetch here.
	if (r.ok) showToast(t('dashboard.admin.index.claimPlatform.success'));
}
</script>

<template>
	<div>
		<header class="mb-8">
			<p class="lp-eyebrow mb-1">{{ t('dashboard.admin.index.eyebrow') }}</p>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
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

		<NuxtLink
			v-for="item in attention"
			:key="item.href"
			:to="item.href"
			class="card mb-6 flex items-center justify-between gap-4 border-error/20 hover:bg-bg-surface transition-colors"
		>
			<span class="flex items-center gap-3">
				<UiIconBox :icon="item.icon" size="sm" variant="error" rounded="lg" />
				<span class="font-medium text-text-primary">
					{{ t(item.message, { count: item.count }, item.count) }}
				</span>
			</span>
			<Icon name="lucide:arrow-right" class="w-5 h-5 text-text-tertiary" />
		</NuxtLink>

		<div class="grid gap-4 sm:grid-cols-2">
			<NuxtLink v-for="group in groups" :key="group.key" :to="group.href" class="group">
				<UiCard hoverable class="h-full">
					<div class="flex items-start gap-3">
						<UiIconBox :icon="group.icon" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="font-semibold text-text-primary">{{ group.title }}</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ group.description }}</p>
						</div>
					</div>
				</UiCard>
			</NuxtLink>
		</div>

		<!-- Nobody holds the roster yet and this is the owner: offer the claim -->
		<section v-if="isPlatformAdmin !== true && canClaimPlatformAdmin" class="mt-10">
			<h2 class="mb-4 text-lg font-semibold text-text-primary">
				{{ t('dashboard.admin.index.platform') }}
			</h2>
			<div class="card flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div class="flex items-start gap-3">
					<UiIconBox icon="lucide:shield-check" size="md" variant="brand" rounded="lg" />
					<div>
						<h3 class="font-semibold text-text-primary">
							{{ t('dashboard.admin.index.claimPlatform.title') }}
						</h3>
						<p class="mt-1 max-w-2xl text-sm text-text-secondary">
							{{ t('dashboard.admin.index.claimPlatform.body') }}
						</p>
					</div>
				</div>
				<UiButton
					variant="primary"
					:loading="claiming"
					class="shrink-0"
					@click="onClaimPlatformAdmin"
				>
					{{ t('dashboard.admin.index.claimPlatform.action') }}
				</UiButton>
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
