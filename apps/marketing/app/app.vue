<script setup lang="ts">
/* `useLocaleHead()` is what makes the site's localization legible to machines:
 * it writes `<html lang>`/`dir` from the active locale and emits the
 * `hreflang` alternates + canonical for every locale of the current route
 * (absolute, via `i18n.baseUrl` in nuxt.config). @nuxtjs/i18n only injects
 * these automatically under `experimental.strictSeo`, so the app does it here,
 * once, for every page. */
const localeHead = useLocaleHead();

useHead(() => ({
	htmlAttrs: localeHead.value.htmlAttrs,
	link: localeHead.value.link,
	meta: localeHead.value.meta,
}));
</script>

<template>
	<NuxtLayout>
		<NuxtPage />
	</NuxtLayout>
</template>
