<script setup lang="ts">
const { t, te, locale } = useI18n();
const route = useRoute();

// `route.params.slug` is already locale-free: `@nuxtjs/i18n` owns the `/de`
// segment, so `/de/guide/topics` and `/guide/topics` both resolve to
// `guide/topics` here and address the same content path in either collection.
const slug = computed(() => (route.params.slug as string[])?.join('/') || 'index');
const path = computed(() => `/${slug.value}`);

// Untranslated German pages fall back to their English source rather than
// 404ing — see `queryDocsPage`.
const { data: page } = await useAsyncData(
	() => `content-${locale.value}-${slug.value}`,
	() => queryDocsPage(docsCollection(locale.value), path.value),
	{ watch: [() => slug.value, locale] }
);

if (!page.value) {
	throw createError({ statusCode: 404, message: t('error.pageNotFound') });
}

const section = computed(() => {
	const segment = slug.value.split('/')[0] ?? '';
	const key = `sections.${segment}`;
	return te(key) ? t(key) : '';
});

const pageTitle = computed(() =>
	page.value?.title ? t('seo.pageTitle', { title: page.value.title }) : t('brand.docs')
);

// Getters, not values: a bare `t()` here would freeze the locale that happened
// to be active when the page was set up.
useSeoMeta({
	title: () => pageTitle.value,
	ogTitle: () => pageTitle.value,
	description: () => page.value?.description || '',
	ogDescription: () => page.value?.description || '',
});

// Plain values, not getters: og-image options are serialized into the image
// URL, so a function would not survive the trip. The locale is fixed for a
// given route — switching locale navigates to `/de/…` and renders this page
// again — so there is nothing here to keep reactive.
defineOgImage('Docs', {
	title: page.value?.title || t('brand.docs'),
	description: page.value?.description || '',
	section: section.value,
});
</script>

<template>
	<div v-if="page" class="content-page">
		<h1 class="content-title font-display text-[2.75rem] max-md:text-[2rem] max-sm:text-[1.5rem] font-normal tracking-[-0.01em] leading-[1.15] text-text-primary mb-5">
			{{ page.title }}
		</h1>
		<p v-if="page.description" class="content-description text-text-secondary text-[0.9375rem] leading-relaxed mb-8">
			{{ page.description }}
		</p>
		<ContentRenderer :value="page" class="prose" />
	</div>
</template>

<style scoped>
.content-title {
	animation: content-enter 0.5s var(--ease-spring) both;
}

.content-description {
	animation: content-enter 0.5s var(--ease-spring) 0.05s both;
}

@keyframes content-enter {
	from {
		opacity: 0;
		transform: translateY(10px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
</style>
