<template>
	<div class="min-h-dvh bg-bg-base flex flex-col">
		<DocsHeader />

		<main class="flex-1 flex items-center justify-center px-6 py-20">
			<div class="max-w-lg text-center">
				<p class="text-2xs font-medium uppercase tracking-widest text-text-tertiary mb-3">
					{{ error?.statusCode ?? 500 }}
				</p>
				<h1
					class="font-display text-[2.25rem] max-sm:text-[1.75rem] font-normal tracking-[-0.01em] leading-[1.15] text-text-primary mb-4"
				>
					{{ isNotFound ? t('error.notFound.title') : t('error.generic.title') }}
				</h1>
				<p class="text-text-secondary text-[0.9375rem] leading-relaxed mb-8">
					{{ isNotFound ? t('error.notFound.body') : t('error.generic.body') }}
				</p>
				<div class="flex items-center justify-center gap-3">
					<NuxtLink
						:to="localePath('/')"
						class="inline-flex items-center h-9 px-4 rounded-full bg-brand text-white text-caption font-medium no-underline"
						@click="clear"
					>
						{{ t('error.backHome') }}
					</NuxtLink>
					<NuxtLink
						:to="localePath('/guide/getting-started')"
						class="inline-flex items-center h-9 px-4 rounded-full border border-border-default text-text-secondary hover:text-text-primary text-caption font-medium no-underline transition-colors duration-(--motion-fast)"
						@click="clear"
					>
						{{ t('error.readTheGuide') }}
					</NuxtLink>
				</div>
			</div>
		</main>

		<DocsFooter />
	</div>
</template>

<script setup lang="ts">
import type { NuxtError } from '#app';

/**
 * The error page renders OUTSIDE the router's matched route, so it keeps the
 * locale that was active when the failure happened; every link back into the
 * site therefore goes through `localePath` to stay in that locale.
 *
 * A missing German *page* never reaches here — untranslated content falls back
 * to its English source — so a 404 on `/de/…` really is a wrong URL.
 */
const props = defineProps<{ error?: NuxtError }>();

const { t } = useI18n();
const localePath = useLocalePath();

const isNotFound = computed(() => props.error?.statusCode === 404);

const title = computed(() =>
	t('seo.pageTitle', {
		title: isNotFound.value ? t('error.notFound.title') : t('error.generic.title'),
	})
);

useSeoMeta({ title: () => title.value, robots: 'noindex' });

function clear() {
	clearError();
}
</script>
