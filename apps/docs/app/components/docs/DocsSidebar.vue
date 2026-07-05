<template>
	<nav class="space-y-6" aria-label="Documentation navigation">
		<div v-for="group in visibleGroups" :key="group.label">
			<h3 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2 px-2">
				{{ group.label }}
			</h3>
			<ul class="space-y-0.5">
				<li v-for="item in group.items" :key="item.to">
					<NuxtLink
						:to="item.to"
						class="sidebar-link group block px-3 py-1.5 text-sm rounded-lg"
						:class="
							isActive(item.to)
								? 'active text-brand'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						<span class="sidebar-link-text">{{ item.label }}</span>
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

<style scoped>
.sidebar-link {
	position: relative;
	transition: all var(--motion-moderate) var(--ease-spring);
}

/* Animated pill background for active state */
.sidebar-link::before {
	content: '';
	position: absolute;
	inset: 0;
	border-radius: 8px;
	background: var(--color-brand-soft);
	opacity: 0;
	transform: scale(0.92);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	z-index: -1;
}

.sidebar-link.active::before {
	opacity: 1;
	transform: scale(1);
}

/* Active left border accent */
.sidebar-link.active::after {
	content: '';
	position: absolute;
	left: 0;
	top: 4px;
	bottom: 4px;
	width: 2px;
	border-radius: 1px;
	background: var(--color-brand);
	animation: indicator-in var(--motion-moderate) var(--ease-spring) both;
}

@keyframes indicator-in {
	from {
		transform: scaleY(0);
		opacity: 0;
	}
	to {
		transform: scaleY(1);
		opacity: 1;
	}
}

/* Hover state for non-active */
.sidebar-link:not(.active):hover::before {
	opacity: 0.5;
	transform: scale(1);
	background: var(--color-bg-surface);
}

.sidebar-link-text {
	position: relative;
	z-index: 1;
	transition: font-weight var(--motion-fast) var(--ease-spring);
}

/* Selection reads through weight, not color alone */
.sidebar-link.active .sidebar-link-text {
	font-weight: var(--font-weight-medium, 450);
}
</style>
