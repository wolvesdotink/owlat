<script setup lang="ts">
/**
 * Template library tabs: Templates, Saved blocks, Media library.
 *
 * The same bar as the Audience tabs (`AudienceTabs`): links between real
 * routes (each tab keeps its own URL), so it is a `nav` with `aria-current`,
 * not an ARIA tablist. The labels are the breadcrumb's page names, so the tab,
 * the trail and the command palette say the same word.
 */
import { api } from '@owlat/api';

const { t, locale } = useI18n();
const route = useRoute();

const { data: typeCounts } = useOrganizationQuery(
	api.emailTemplates.organization.countByTypeByOrganization
);
const { data: blockStats } = useOrganizationQuery(api.emailBlocks.blocks.getStatsByTeam);

const tabs = computed(() =>
	[
		{
			key: 'templates',
			to: '/dashboard/send',
			label: t('shared.breadcrumbRoutes.pages.templates'),
			count: typeCounts.value?.['total'],
			// The section root: the other tabs live under its path, so only an
			// exact match marks it.
			exact: true,
		},
		{
			key: 'blocks',
			to: '/dashboard/send/blocks',
			label: t('shared.breadcrumbRoutes.pages.blocks'),
			count: blockStats.value?.total,
			exact: false,
		},
		{
			key: 'media',
			to: '/dashboard/send/media',
			label: t('shared.breadcrumbRoutes.pages.media'),
			count: undefined,
			exact: false,
		},
	].map((tab) => ({
		...tab,
		active: route.path === tab.to || (!tab.exact && route.path.startsWith(`${tab.to}/`)),
		countLabel: typeof tab.count === 'number' ? tab.count.toLocaleString(locale.value) : null,
	}))
);
</script>

<template>
	<nav
		:aria-label="t('shared.breadcrumbRoutes.pages.templates')"
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
							? 'border-brand text-text-primary font-medium'
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
