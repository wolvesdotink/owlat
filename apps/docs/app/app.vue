<template>
	<NuxtLayout>
		<NuxtPage :transition="{ name: 'page', mode: 'out-in' }" />
	</NuxtLayout>
</template>

<script setup lang="ts">
/**
 * `useLocaleHead()` is what makes the document itself bilingual:
 *  - `htmlAttrs.lang`/`dir` follow the active locale (which is also why
 *    `app.head.htmlAttrs.lang` is NOT pinned in nuxt.config — a value set there
 *    outranks this one and would leave every `/de/…` page claiming `lang="en"`);
 *  - `link` carries the `hreflang` alternates and `x-default`, resolved against
 *    `i18n.baseUrl` so search engines get absolute URLs;
 *  - `meta` carries `og:locale` / `og:locale:alternate`.
 *
 * It is bound through a `useHead` getter rather than spread once, so the tags
 * are re-evaluated when the locale changes instead of freezing at first render.
 */
const localeHead = useLocaleHead();

useHead(() => ({
	htmlAttrs: localeHead.value.htmlAttrs,
	link: localeHead.value.link,
	meta: localeHead.value.meta,
}));
</script>
