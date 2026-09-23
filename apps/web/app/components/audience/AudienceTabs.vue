<script setup lang="ts">
/**
 * Audience section tabs (#787): Contacts, Topics, Segments, Suppressions.
 *
 * Audience opens on the contact list; the old overview's stat tiles live on
 * here as the tab counts. These are links between real routes (each tab keeps
 * its own URL), so the bar is a `nav` with `aria-current`, not an ARIA
 * tablist. Topics and segments are admin tools, gated like the sidebar.
 */
import { api } from '@owlat/api';

const { t, locale } = useI18n();
const route = useRoute();
const { isAdmin } = usePermissions();

const { data: stats } = useOrganizationQuery(api.contacts.analytics.getAudienceStats);

const tabs = computed(() => {
	const counts = stats.value;
	const all = [
		{
			key: 'contacts',
			to: '/dashboard/audience/contacts',
			label: t('shared.dashboardNavigation.items.audience.contacts'),
			count: counts?.totalContacts,
			show: true,
		},
		{
			key: 'topics',
			to: '/dashboard/audience/topics',
			label: t('shared.dashboardNavigation.items.audience.topics'),
			count: counts?.topicCount,
			show: isAdmin.value,
		},
		{
			key: 'segments',
			to: '/dashboard/audience/segments',
			label: t('shared.dashboardNavigation.items.audience.segments'),
			count: counts?.segmentCount,
			show: isAdmin.value,
		},
		{
			key: 'suppressions',
			to: '/dashboard/audience/suppressions',
			label: t('shared.dashboardNavigation.items.audience.suppressions'),
			count: undefined,
			show: true,
		},
	];
	return all
		.filter((tab) => tab.show)
		.map((tab) => ({
			...tab,
			active: route.path === tab.to || route.path.startsWith(`${tab.to}/`),
			countLabel: typeof tab.count === 'number' ? tab.count.toLocaleString(locale.value) : null,
		}));
});
</script>

<template>
	<nav
		:aria-label="t('shared.dashboardNavigation.sections.audience')"
		class="mb-6 -mx-1 overflow-x-auto border-b border-border-subtle"
	>
		<ul class="flex gap-1 px-1">
			<li v-for="tab in tabs" :key="tab.key">
				<NuxtLink
					:to="tab.to"
					:aria-current="tab.active ? 'page' : undefined"
					:data-tab="tab.key"
					:class="[
						'inline-flex items-center gap-1.5 px-3 py-2 -mb-px border-b-2 text-sm whitespace-nowrap transition-colors duration-(--motion-fast)',
						tab.active
							? 'border-text-primary text-text-primary font-medium'
							: 'border-transparent text-text-secondary hover:text-text-primary',
					]"
				>
					{{ tab.label }}
					<span v-if="tab.countLabel !== null" class="text-xs text-text-tertiary tabular-nums">{{
						tab.countLabel
					}}</span>
				</NuxtLink>
			</li>
		</ul>
	</nav>
</template>
