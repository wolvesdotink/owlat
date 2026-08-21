<template>
	<nav v-if="crumbs.length > 1" class="max-w-3xl mx-auto mb-6" :aria-label="t('breadcrumb.label')">
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
						:to="localePath(crumb.path)"
						class="text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast)"
					>
						{{ crumb.label }}
					</NuxtLink>
					<span v-else class="text-text-primary font-medium" aria-current="page">
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

const { t, te, locale } = useI18n();
const localePath = useLocalePath();
const route = useRoute();

const crumbs = computed<Crumb[]>(() => {
	// Locale-free segments: on `/de/guide/topics` the `/de` is routing, not a
	// crumb, and `localePath` puts it back on every link below.
	const segments = contentPath(route.path, locale.value).split('/').filter(Boolean);
	if (segments.length === 0) return [];

	const items: Crumb[] = [{ label: t('breadcrumb.root'), path: '/' }];

	let currentPath = '';
	for (const segment of segments) {
		currentPath += `/${segment}`;
		items.push({
			label: segmentLabel(segment),
			path: currentPath,
		});
	}

	return items;
});

/**
 * A crumb's text: the translated section name where the catalog has one, else
 * the slug title-cased. The de-slugified fallback is English-shaped, but it is
 * derived from the URL — which is English in every locale — so it is the same
 * string a German reader sees in their address bar.
 */
function segmentLabel(segment: string): string {
	const key = `sections.${segment}`;
	return te(key) ? t(key) : formatSegment(segment);
}

function formatSegment(segment: string): string {
	return segment.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
</script>
