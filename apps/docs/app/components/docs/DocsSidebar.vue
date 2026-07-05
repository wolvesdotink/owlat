<template>
	<nav class="space-y-6" aria-label="Documentation navigation">
		<div v-for="group in visibleGroups" :key="group.label">
			<h3 class="text-xs uppercase tracking-widest text-text-tertiary mb-2 px-2">
				{{ group.label }}
			</h3>
			<ul class="space-y-0.5">
				<li v-for="item in group.items" :key="item.to">
					<NuxtLink
						:to="item.to"
						class="block px-3 py-1.5 text-sm rounded-lg transition-colors duration-(--motion-fast)"
						:class="
							isActive(item.to)
								? 'text-text-primary bg-bg-surface font-medium'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						{{ item.label }}
					</NuxtLink>
				</li>
			</ul>
		</div>
	</nav>
</template>

<script setup lang="ts">
import { sidebarGroupsForSection } from '../../utils/sidebarConfig';

const route = useRoute();

const currentSection = computed(() => {
	const segments = route.path.split('/');
	return segments[1] || '';
});

const visibleGroups = computed(() => sidebarGroupsForSection(currentSection.value));

function isActive(path: string): boolean {
	return route.path === path;
}
</script>
