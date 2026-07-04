<template>
	<nav v-if="crumbs.length > 1" class="max-w-3xl mx-auto mb-6" aria-label="Breadcrumb">
		<ol class="flex items-center gap-1.5 text-sm">
			<li v-for="(crumb, index) in crumbs" :key="crumb.path">
				<div class="flex items-center gap-1.5">
					<!-- Separator -->
					<svg
						v-if="index > 0"
						class="w-3.5 h-3.5 text-text-disabled"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M9 5l7 7-7 7"
						/>
					</svg>

					<!-- Link or current -->
					<NuxtLink
						v-if="index < crumbs.length - 1"
						:to="crumb.path"
						class="text-text-tertiary hover:text-text-secondary transition-colors duration-(--motion-fast)"
					>
						{{ crumb.label }}
					</NuxtLink>
					<span v-else class="text-text-secondary" aria-current="page">
						{{ crumb.label }}
					</span>
				</div>
			</li>
		</ol>
	</nav>
</template>

<script setup lang="ts">
interface Crumb {
	label: string;
	path: string;
}

const route = useRoute();

const crumbs = computed<Crumb[]>(() => {
	const segments = route.path.split('/').filter(Boolean);
	if (segments.length === 0) return [];

	const items: Crumb[] = [{ label: 'Docs', path: '/' }];

	let currentPath = '';
	for (const segment of segments) {
		currentPath += `/${segment}`;
		items.push({
			label: formatSegment(segment),
			path: currentPath,
		});
	}

	return items;
});

function formatSegment(segment: string): string {
	return segment.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
</script>
