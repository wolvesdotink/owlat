<template>
	<nav class="space-y-6" :aria-label="t('nav.sidebar')">
		<div v-for="group in visibleGroups" :key="group.label">
			<h3 class="text-2xs font-medium uppercase tracking-widest text-text-tertiary mb-2 px-3">
				{{ groupLabel(group) }}
			</h3>
			<ul class="space-y-0.5">
				<li v-for="item in group.items" :key="item.to">
					<NuxtLink
						:to="localePath(item.to)"
						class="block px-3 py-1.5 text-sm rounded-lg transition-colors duration-(--motion-fast)"
						:class="
							isActive(item.to)
								? 'text-text-primary font-semibold'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						{{ itemLabel(item) }}
					</NuxtLink>
				</li>
			</ul>
		</div>
	</nav>
</template>

<script setup lang="ts">
import {
	sidebarGroupKey,
	sidebarGroupsForSection,
	sidebarItemKey,
	type SidebarGroup,
	type SidebarItem,
} from '../../utils/sidebarConfig';
import { contentPath } from '../../composables/useDocsContent';

const { t, te, locale } = useI18n();
const route = useRoute();
const localePath = useLocalePath();

// The section is read off the LOCALE-FREE path: on `/de/guide/…` the first
// segment is the locale, not the section, and the nav would come up empty.
const currentSection = computed(() => {
	const segments = contentPath(route.path, locale.value).split('/');
	return segments[1] || '';
});

const visibleGroups = computed(() => sidebarGroupsForSection(currentSection.value));

/**
 * A catalog string when the locale has one, the config's English label
 * otherwise — a page added to the nav without a catalog entry reads as English
 * rather than as `sidebar.items.guide-new-page`.
 */
function translated(key: string, fallback: string): string {
	return te(key) ? t(key) : fallback;
}

function groupLabel(group: SidebarGroup): string {
	return translated(sidebarGroupKey(group), group.label);
}

function itemLabel(item: SidebarItem): string {
	return translated(sidebarItemKey(item), item.label);
}

function isActive(path: string): boolean {
	return contentPath(route.path, locale.value) === path;
}
</script>
