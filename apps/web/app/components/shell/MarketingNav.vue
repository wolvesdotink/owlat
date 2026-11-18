<script setup lang="ts">
import { api } from '@owlat/api';
import type { ConversationStatus } from '~/utils/conversationStatus';
import type { NavigationItem } from '~/lib/dashboardNavigationCore';
import {
	ChartBarVerticalIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	FileCodeIcon,
	LayoutTemplateIcon,
	MegaphoneIcon,
	TrashIcon,
	UsersIcon,
	ZapIcon,
} from '@coolicons/vue';
import { navIcon } from '~/lib/navIcons';
import { sendingZones } from '~/lib/sidebarContext';
import { campaignHref } from '~/utils/campaignDestination';
import { useNow } from '~/composables/useNow';

/**
 * The Sending workspace's sidebar, in two zones. Marketing: Overview, then the
 * campaigns and automations themselves as rows with one status each (the same
 * pattern as the Conversations sidebar). Transactional: the latest API-triggered
 * emails. Below both, Audience, Templates and Recently deleted, and one quiet
 * delivery line at the bottom.
 *
 * The zone labels only render while both zones do; with one zone the rail is
 * the flat list it would be without the other. Zone labels are uppercase and
 * the Campaigns/Automations headers under them switch to sentence case, so
 * the two levels read apart without a third indent.
 */
const props = defineProps<{
	collapsed: boolean;
	extraItems: readonly NavigationItem[];
}>();

const { t } = useI18n();
const route = useRoute();
const { isEnabled } = useFeatureFlag();
const { can, isAdmin, isRoleLoading, role } = usePermissions();
const { isCollapsed, toggleGroup } = useShellSidebarPrefs();

const campaignsOn = computed(() => isEnabled('campaigns'));
const automationsOn = computed(() => isAdmin.value && isEnabled('automations'));
const zones = computed(() =>
	sendingZones({ isFeatureEnabled: isEnabled, isDesktop: false, role: role.value })
);

const CAMPAIGNS_HREF = '/dashboard/campaigns';
const AUTOMATIONS_HREF = '/dashboard/automations';
const TRANSACTIONAL_HREF = '/dashboard/send/transactional';
/** The list page opens its create dialog for this query (see `lib/quickCreate`). */
const NEW_TRANSACTIONAL_HREF = `${TRANSACTIONAL_HREF}?action=create`;
const TRANSACTIONAL_ROWS = 3;

const { data: attention } = useConvexQuery(api.campaigns.organization.listAttentionCandidates, () =>
	campaignsOn.value ? {} : 'skip'
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
// Ticks once a minute, so "Results in" expires and a scheduled send's time
// flips while the shell stays mounted.
const nowRef = useNow({ intervalMs: 60_000 });

function campaignStatus(c: {
	status: string;
	sentAt?: number;
	contentBlockReason?: string;
	/** A scheduled start that did not happen; the campaign is a draft again. */
	startRefusal?: unknown;
	isABTest?: boolean;
	abTestStatus?: string;
	abWinner?: string;
}): ConversationStatus | null {
	if (c.status === 'pending_review' || (c.contentBlockReason && c.status !== 'sent'))
		return 'needs_review';
	if (c.startRefusal && c.status === 'draft') return 'needs_review';
	if (c.isABTest && c.abTestStatus === 'testing' && !c.abWinner) return 'needs_review';
	if (c.status === 'sending') return 'running';
	if (c.status === 'scheduled') return 'scheduled';
	if (c.status === 'sent' && c.sentAt && nowRef.value - c.sentAt < RESULTS_WINDOW_MS)
		return 'results_in';
	return null;
}

const campaignRows = computed(() => {
	const seen = new Set<string>();
	const rows: Array<{
		id: string;
		name: string;
		href: string;
		status: ConversationStatus | null;
		meta: string;
	}> = [];
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
		const upcoming =
			c.scheduledAt !== undefined && c.scheduledAt > nowRef.value ? c.scheduledAt : undefined;
		const at = upcoming ?? c.sentAt ?? c.updatedAt;
		rows.push({
			id: c._id,
			name: c.name,
			href: campaignHref(c),
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

// A bounded read: this sidebar is mounted on every page of the workspace.
const { data: recentTransactional } = useConvexQuery(api.transactional.emails.listRecent, () =>
	zones.value.transactional ? { limit: TRANSACTIONAL_ROWS } : 'skip'
);

// Published emails show when they last changed; anything else says why it is
// not live: a draft, or held for review after a content scan.
const transactionalRows = computed(() =>
	(recentTransactional.value ?? []).map((email) => ({
		id: email._id as string,
		name: email.name,
		status: email.status === 'pending_review' ? ('needs_review' as const) : null,
		meta:
			email.status === 'draft'
				? t('components.shell.marketing.draft')
				: formatCompactRelativeTime(email.updatedAt),
	}))
);

const links = computed(() =>
	[
		{
			to: '/dashboard/audience',
			icon: UsersIcon,
			label: t('components.shell.marketing.audience'),
			show: true,
		},
		{
			to: '/dashboard/send',
			icon: LayoutTemplateIcon,
			label: t('components.shell.marketing.templates'),
			show: isAdmin.value,
		},
		{
			// Shown to whoever could restore something there (the page's own tabs).
			to: '/dashboard/marketing/deleted',
			icon: TrashIcon,
			label: t('components.shell.marketing.recentlyDeleted'),
			show:
				(campaignsOn.value && can('campaigns:manage')) ||
				(automationsOn.value && can('automations:manage')) ||
				can('templates:manage'),
		},
	].filter((l) => l.show)
);

// The collapsed rail: one icon per group, then the shared links and the plugin
// items. The delivery line has no icon here.
const railLinks = computed(() => [
	...(campaignsOn.value
		? [
				{
					to: CAMPAIGNS_HREF,
					icon: MegaphoneIcon,
					label: t('components.shell.marketing.campaigns'),
				},
			]
		: []),
	...(automationsOn.value
		? [
				{
					to: AUTOMATIONS_HREF,
					icon: ZapIcon,
					label: t('components.shell.marketing.automations'),
				},
			]
		: []),
	...(zones.value.transactional
		? [
				{
					to: TRANSACTIONAL_HREF,
					icon: FileCodeIcon,
					label: t('shared.breadcrumbRoutes.sections.transactional'),
				},
			]
		: []),
	...links.value,
	...props.extraItems.map((i) => ({ to: i.href, icon: i.icon, label: t(i.name) })),
]);

const { level: healthLevel, reason: healthReason } = useDeliveryHealth();

function isActive(to: string, exact = false): boolean {
	if (exact) return route.path === to;
	// Transactional emails live under Templates' URL but have their own zone.
	if (to === '/dashboard/send' && isActive(TRANSACTIONAL_HREF)) return false;
	return route.path === to || route.path.startsWith(`${to}/`);
}
const activeCampaignId = computed(
	() => /^\/dashboard\/campaigns\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);
const activeAutomationId = computed(
	() => /^\/dashboard\/automations\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);
const activeTransactionalId = computed(
	() => /^\/dashboard\/send\/transactional\/([^/?#]+)/.exec(route.path)?.[1] ?? null
);

// Under a zone label a group header steps down to sentence case; without one
// it keeps the rail's usual uppercase header.
const groupHeaderClass = computed(() =>
	zones.value.labelled
		? 'text-xs font-medium text-text-tertiary'
		: 'text-2xs font-medium uppercase tracking-wider text-text-tertiary'
);
const ZONE_LABEL_CLASS =
	'text-2xs font-semibold uppercase tracking-wider text-text-secondary hover:text-text-primary';
</script>

<template>
	<div class="flex flex-col gap-px">
		<h2
			v-if="zones.labelled && !props.collapsed"
			class="px-3 pb-1 pt-1"
			:class="ZONE_LABEL_CLASS"
			data-testid="shell-sending-zone-marketing"
		>
			{{ t('shared.breadcrumbRoutes.sections.marketing') }}
		</h2>

		<UiTooltip
			v-if="campaignsOn"
			:text="props.collapsed ? t('components.shell.marketing.overview') : undefined"
		>
			<NuxtLink
				to="/dashboard/marketing"
				:aria-label="props.collapsed ? t('components.shell.marketing.overview') : undefined"
				:aria-current="isActive('/dashboard/marketing', true) ? 'page' : undefined"
				class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
				:class="[
					isActive('/dashboard/marketing', true)
						? 'bg-(--surface-2-selected) text-text-primary'
						: 'text-text-secondary hover:bg-(--surface-2-hover) hover:text-text-primary',
					props.collapsed ? 'justify-center' : '',
				]"
			>
				<component
					:is="navIcon(ChartBarVerticalIcon, isActive('/dashboard/marketing', true))"
					class="size-4.5 shrink-0"
					:class="isActive('/dashboard/marketing', true) ? 'text-brand' : 'text-text-tertiary'"
				/>
				<span v-if="!props.collapsed">{{ t('components.shell.marketing.overview') }}</span>
			</NuxtLink>
		</UiTooltip>

		<template v-if="!props.collapsed">
			<template v-if="campaignsOn">
				<ShellGroupHeader
					class="mt-3"
					:name="t('components.shell.marketing.campaigns')"
					:to="CAMPAIGNS_HREF"
					:collapsed="isCollapsed('campaigns')"
					:name-class="groupHeaderClass"
					create-to="/dashboard/campaigns/new"
					:create-label="t('components.shell.marketing.newCampaign')"
					@toggle="toggleGroup('campaigns')"
				/>
				<div v-if="!isCollapsed('campaigns')" class="space-y-px">
					<ShellThreadRow
						v-for="row in campaignRows"
						:key="row.id"
						:to="row.href"
						:jump-key="`campaign:${row.id}`"
						:title="row.name"
						:meta="row.meta"
						:status="row.status"
						:is-active="activeCampaignId === row.id"
					/>
				</div>
			</template>

			<template v-if="automationsOn">
				<ShellGroupHeader
					class="mt-3"
					:name="t('components.shell.marketing.automations')"
					:to="AUTOMATIONS_HREF"
					:collapsed="isCollapsed('automations')"
					:name-class="groupHeaderClass"
					@toggle="toggleGroup('automations')"
				/>
				<div v-if="!isCollapsed('automations')" class="space-y-px">
					<ShellThreadRow
						v-for="row in automationRows"
						:key="row.id"
						:to="`/dashboard/automations/${row.id}`"
						:jump-key="`automation:${row.id}`"
						:title="row.name"
						:is-active="activeAutomationId === row.id"
					/>
				</div>
			</template>

			<!-- The Transactional zone. Labelled, its zone label is the group name;
			     alone, it is a group like Campaigns. -->
			<template v-if="zones.transactional">
				<ShellGroupHeader
					:class="zones.labelled ? 'mt-5' : campaignsOn || automationsOn ? 'mt-3' : ''"
					:name="t('shared.breadcrumbRoutes.sections.transactional')"
					:to="TRANSACTIONAL_HREF"
					:collapsed="isCollapsed('transactional')"
					:name-class="zones.labelled ? ZONE_LABEL_CLASS : groupHeaderClass"
					:heading="zones.labelled"
					:create-to="NEW_TRANSACTIONAL_HREF"
					:create-label="t('components.shell.marketing.newTransactional')"
					:data-testid="zones.labelled ? 'shell-sending-zone-transactional' : undefined"
					@toggle="toggleGroup('transactional')"
				/>
				<div v-if="!isCollapsed('transactional')" class="space-y-px">
					<ShellThreadRow
						v-for="row in transactionalRows"
						:key="row.id"
						:to="`${TRANSACTIONAL_HREF}/${row.id}/edit`"
						:jump-key="`transactional:${row.id}`"
						:title="row.name"
						:meta="row.meta"
						:status="row.status"
						:is-active="activeTransactionalId === row.id"
					/>
				</div>
			</template>

			<!-- Automations, Transactional and Templates are admin-only, and the page
			     renders before the role is known: hold their place instead of
			     letting them pop in. -->
			<div
				v-if="isRoleLoading"
				class="mt-3 space-y-2 px-3"
				data-testid="shell-marketing-role-skeleton"
			>
				<UiSkeleton v-if="isEnabled('automations')" class="h-3 w-24" />
				<UiSkeleton v-if="isEnabled('transactional')" class="h-3 w-28" />
				<UiSkeleton class="h-4 w-3/4" />
			</div>

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
					<component
						:is="navIcon(link.icon, isActive(link.to))"
						class="size-4"
						:class="isActive(link.to) ? 'text-brand' : 'text-text-tertiary'"
					/>
					<span class="truncate">{{ link.label }}</span>
				</NuxtLink>
			</div>

			<!-- The reason in full: the line below truncates it. -->
			<UiTooltip v-if="isAdmin && healthLevel" :text="healthReason || undefined">
				<NuxtLink
					to="/dashboard/admin/delivery"
					class="mt-3 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-(--surface-2-hover)"
				>
					<component
						:is="healthLevel === 'ok' ? CircleCheckIcon : CircleWarningIcon"
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
							: healthReason || t('components.shell.marketing.deliveryNeedsAttention')
					}}</span>
				</NuxtLink>
			</UiTooltip>
		</template>

		<template v-else>
			<UiTooltip v-for="link in railLinks" :key="link.to" :text="link.label">
				<NuxtLink
					:to="link.to"
					:aria-label="link.label"
					:aria-current="isActive(link.to) ? 'page' : undefined"
					class="flex justify-center rounded-lg py-2 transition-colors"
					:class="
						isActive(link.to)
							? 'bg-(--surface-2-selected) text-brand'
							: 'text-text-tertiary hover:bg-(--surface-2-hover) hover:text-text-primary'
					"
				>
					<component :is="navIcon(link.icon, isActive(link.to))" class="size-4.5" />
				</NuxtLink>
			</UiTooltip>
		</template>
	</div>
</template>
