<script setup lang="ts">
const route = useRoute();
const slug = (route.params.slug as string[])?.join('/') || 'index';

const { data: page } = await useAsyncData(`content-${slug}`, () =>
	queryCollection('content').path(`/${slug}`).first(),
);

if (!page.value) {
	throw createError({ statusCode: 404, message: 'Page not found' });
}

const sectionMap: Record<string, string> = {
	guide: 'Guide',
	api: 'API Reference',
	developer: 'Developer',
};

const pathSegments = slug.split('/');
const section = sectionMap[pathSegments[0]!] || '';

const pageTitle = page.value.title
	? `${page.value.title} | Owlat Docs`
	: 'Owlat Docs';

useSeoMeta({
	title: pageTitle,
	ogTitle: pageTitle,
	description: page.value.description || '',
	ogDescription: page.value.description || '',
});

defineOgImage('Docs', {
	title: page.value.title || 'Owlat Docs',
	description: page.value.description || '',
	section,
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
	animation: content-enter 0.5s var(--ease-out-expo) both;
}

.content-description {
	animation: content-enter 0.5s var(--ease-out-expo) 0.05s both;
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
