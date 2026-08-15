<template>
	<NuxtLink v-if="internalTo" :to="internalTo" :target="target">
		<slot />
	</NuxtLink>
	<a v-else :href="href" :target="target ?? undefined" :rel="external ? 'noopener noreferrer' : undefined">
		<slot />
	</a>
</template>

<script setup lang="ts">
/**
 * The MDC `ProseA` override — every link written inside a markdown page.
 *
 * Content pages link each other by their locale-free path (`/guide/topics`),
 * because that is the path the collection stores in every locale. Rendered
 * as-is on a German page, the first in-body link would silently drop the reader
 * back into English: the chrome around them stays German, the URL loses `/de`,
 * and every link after it is English too. Routing them through `localePath`
 * keeps a reader inside the locale they chose — including on pages that are
 * still an English fallback, where staying in `/de` is what lets the rest of
 * the surrounding navigation remain German.
 *
 * Only absolute in-app paths are rewritten. Anchors (`#section`) must stay
 * untouched or they would resolve against the router as a route NAME, and
 * external URLs are not ours to prefix.
 */
const props = defineProps<{
	href?: string;
	target?: string | null;
}>();

const localePath = useLocalePath();

const external = computed(() => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(props.href ?? ''));

const internalTo = computed(() => {
	const href = props.href ?? '';
	if (!href.startsWith('/') || external.value) return null;
	return localePath(href);
});
</script>
