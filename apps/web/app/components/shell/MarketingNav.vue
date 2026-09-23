<script setup lang="ts">
import { api } from '@owlat/api';
import type { ConversationStatus } from '~/utils/conversationStatus';
import type { NavigationItem } from '~/lib/dashboardNavigationCore';

/**
 * The Marketing workspace's sidebar: Overview first, then the campaigns and
 * automations themselves as rows with one status each (the same pattern as the
 * Conversations sidebar), then Audience and Templates. One quiet delivery line
 * at the bottom replaces the old Administration health dot.
 */
const props = defineProps<{
	collapsed: boolean;
	extraItems: readonly NavigationItem[];
}>();

const { t } = useI18n();
const route = useRoute();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { isCollapsed, toggleGroup } = useShellSidebarPrefs();

const campaignsOn = computed(() => isEnabled('campaigns'));
const automationsOn = computed(() => isAdmin.value && isEnabled('automations'));

const { data: attention } = useConvexQuery(
	api.campaigns.organization.listAttentionCandidates,
	() => (campaignsOn.value ? {} : 'skip')
);
const { data: recentPage } = useConvexQuery(api.campaigns.campaigns.list, () =>
	campaignsOn.value ? { paginationOpts: { numItems: 5, cursor: null } } : 'skip'
);
const { data: automationPage } = useConvexQuery(api.automations.automations.list, () =>
	automationsOn.value
		? { status: 'active' as const, paginationOpts: { numItems: 3, cursor: null } }
		: 'skip'
);

const RESULTS_WINDOW_MS = 48 * 60 * 60 * 1000;
const now = Date.now();

function campaignStatus(c: {
	status: string;
	sentAt?: number;
	contentBlockReason?: string;
	isABTest?: boolean;
	abTestStatus?: string;
	abWinner?: string;
}): ConversationStatus | null {
	if (c.status === 'pending_review' || (c.contentBlockReason && c.status !== 'sent'))
		return 'needs_review';
	if (c.isABTest && c.abTestStatus === 'testing' && !c.abWinner) return 'needs_review';
	if (c.status === 'sending') return 'running';
	if (c.status === 'scheduled') return 'scheduled';
	if (c.status === 'sent' && c.sentAt && now - c.sentAt < RESULTS_WINDOW_MS) return 'results_in';
	return null;
}

const campaignRows = computed(() => {
	const seen = new Set<string>();
	const rows: Array<{ id: string; name: string; status: ConversationStatus | null; meta: string }> =
		[];
	const push = (c: {
		_id: string;
		name: string;
		status: string;
		sentAt?: number;
		scheduledAt?: number;
		updatedAt: number;
	}) => {
		if (seen.has(c._id) || c.status === 'cancelled') return;
		seen.add(c._id);
		// A send still ahead of us shows when it goes out; anything else, when it did.
		const upcoming = c.scheduledAt !== undefined && c.scheduledAt > now ? c.scheduledAt : undefined;
		const at = upcoming ?? c.sentAt ?? c.updatedAt;
		rows.push({
			id: c._id,
			name: c.name,
			status: campaignStatus(c),
			meta:
				c.status === 'draft'
					? t('components.shell.marketing.draft')
					: at
						? formatCompactRelativeTime(at)
						: '',
		});
	};
	for (const c of attention.value ?? []) if (campaignStatus(c) === 'needs_review') push(c);
	for (const c of recentPage.value?.page ?? []) push(c);
	return rows.slice(0, 5);
});

const automationRows = computed(() =>
	(automationPage.value?.page ?? []).map((a) => ({ id: a._id as string, name: a.name }))
);

const links = computed(() =>
	[
		{
			to: '/dashboard/audience',
			icon: 'lucide:users',
			label: t('components.shell.marketing.audience'),
			show: true,
		},
		{
			to: '/dashboard/send',
			icon: 'lucide:layout-template',
			label: t('components.shell.marketing.templates'),
			show: isAdmin.value,
		},
	].filter((l) => l.show)
);

const { level: healthLevel, reason: healthReason } = useDeliveryHealth();

function isActive(to: string, exact = false): boolean {
	return exact ? route.path === to : route.path === to || route.path.startsWith(`${to}/`);
}
const activeCampaignId = computed(
	() => /^\/dashboard\/campaigns\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);
const activeAutomationId = computed(
	() => /^\/dashboard\/automations\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);
</script>

<template>
	<div class="flex flex-col gap-px">
		<NuxtLink
			v-if="campaignsOn"
			to="/dashboard/marketing"
			:title="props.collapsed ? t('components.shell.marketing.overview') : undefined"
			:aria-current="isActive('/dashboard/marketing', true) ? 'page' : undefined"
			class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
			:class="[
				isActive('/dashboard/marketing', true)
					? 'bg-(--surface-2-selected) text-text-primary'
					: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary',
				props.collapsed ? 'justify-center' : '',
			]"
		>
			<Icon
				name="lucide:chart-no-axes-column"
				class="size-4.5 shrink-0"
				:class="isActive('/dashboard/marketing', true) ? 'text-brand' : 'text-text-tertiary'"
			/>
			<span v-if="!props.collapsed">{{ t('components.shell.marketing.overview') }}</span>
		</NuxtLink>

		<template v-if="!props.collapsed">
			<template v-if="campaignsOn">
				<div class="group/cmp mt-3 flex items-center gap-1 pr-1">
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary hover:text-text-primary"
						:aria-expanded="!isCollapsed('campaigns')"
						@click="toggleGroup('campaigns')"
					>
						<Icon
							name="lucide:chevron-down"
							class="size-3 transition-transform duration-(--motion-fast)"
							:class="isCollapsed('campaigns') ? '-rotate-90' : ''"
						/>
						{{ t('components.shell.marketing.campaigns') }}
					</button>
					<NuxtLink
						to="/dashboard/campaigns/new"
						class="flex size-6 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
						:aria-label="t('components.shell.marketing.newCampaign')"
						:title="t('components.shell.marketing.newCampaign')"
					>
						<Icon name="lucide:plus" class="size-3.5" />
					</NuxtLink>
				</div>
				<div v-if="!isCollapsed('campaigns')" class="space-y-px">
					<ShellThreadRow
						v-for="row in campaignRows"
						:key="row.id"
						:to="
							row.status === 'results_in'
								? `/dashboard/campaigns/${row.id}/report`
								: `/dashboard/campaigns/${row.id}/edit`
						"
						:jump-key="`campaign:${row.id}`"
						:title="row.name"
						:meta="row.meta"
						:status="row.status"
						:is-active="activeCampaignId === row.id"
					/>
					<NuxtLink
						to="/dashboard/campaigns"
						class="flex items-center rounded-md px-3 py-1 text-2xs text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
						:aria-current="route.path === '/dashboard/campaigns' ? 'page' : undefined"
						>{{ t('components.shell.marketing.allCampaigns') }}</NuxtLink
					>
				</div>
			</template>

			<template v-if="automationsOn">
				<button
					type="button"
					class="mt-3 flex items-center gap-1.5 px-2 py-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary hover:text-text-primary"
					:aria-expanded="!isCollapsed('automations')"
					@click="toggleGroup('automations')"
				>
					<Icon
						name="lucide:chevron-down"
						class="size-3 transition-transform duration-(--motion-fast)"
						:class="isCollapsed('automations') ? '-rotate-90' : ''"
					/>
					{{ t('components.shell.marketing.automations') }}
				</button>
				<div v-if="!isCollapsed('automations')" class="space-y-px">
					<ShellThreadRow
						v-for="row in automationRows"
						:key="row.id"
						:to="`/dashboard/automations/${row.id}`"
						:jump-key="`automation:${row.id}`"
						:title="row.name"
						status="running"
						:is-active="activeAutomationId === row.id"
					/>
					<NuxtLink
						to="/dashboard/automations"
						class="flex items-center rounded-md px-3 py-1 text-2xs text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
						>{{ t('components.shell.marketing.allAutomations') }}</NuxtLink
					>
				</div>
			</template>

			<div class="mt-3 flex flex-col gap-px">
				<NuxtLink
					v-for="link in [
						...links,
						...extraItems.map((i) => ({ to: i.href, icon: i.icon, label: t(i.name), show: true })),
					]"
					:key="link.to"
					:to="link.to"
					:aria-current="isActive(link.to) ? 'page' : undefined"
					class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors"
					:class="
						isActive(link.to)
							? 'bg-(--surface-2-selected) font-medium text-text-primary'
							: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary'
					"
				>
					<Icon :name="link.icon" class="size-4 text-text-tertiary" />
					<span class="truncate">{{ link.label }}</span>
				</NuxtLink>
			</div>

			<NuxtLink
				v-if="isAdmin && healthLevel"
				to="/dashboard/admin/delivery"
				class="mt-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-(--surface-2-hover)"
				:title="healthReason ?? undefined"
			>
				<Icon
					:name="healthLevel === 'ok' ? 'lucide:circle-check' : 'lucide:circle-alert'"
					class="size-4"
					:class="
						healthLevel === 'ok'
							? 'text-success'
							: healthLevel === 'warn'
								? 'text-warning'
								: 'text-error'
					"
				/>
				<span class="truncate">{{
					healthLevel === 'ok'
						? t('components.shell.marketing.deliveryHealthy')
						: (healthReason ?? t('components.shell.marketing.deliveryNeedsAttention'))
				}}</span>
			</NuxtLink>
		</template>

		<template v-else>
			<NuxtLink
				v-for="link in [
					{
						to: '/dashboard/campaigns',
						icon: 'lucide:megaphone',
						label: t('components.shell.marketing.campaigns'),
					},
					...links,
				]"
				:key="link.to"
				:to="link.to"
				:title="link.label"
				class="flex justify-center rounded-lg py-2 text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary"
			>
				<Icon :name="link.icon" class="size-4.5" />
			</NuxtLink>
		</template>
	</div>
</template>
