<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
	error: NuxtError;
}>();

const { t } = useI18n();

// A getter: the title is read when the head is applied, so it follows a locale
// change instead of freezing the one that happened to be active at setup.
useHead({
	title: () =>
		props.error.statusCode === 404
			? t("shell.error.pageTitleNotFound")
			: t("shell.error.pageTitleGeneric"),
});

const handleGoBack = () => {
	clearError({ redirect: "/" });
};

const statusMessage = computed(() => {
	switch (props.error.statusCode) {
		case 404:
			return t("shell.error.notFound");
		case 500:
			return t("shell.error.serverError");
		case 403:
			return t("shell.error.forbidden");
		default:
			// The thrown message is whatever raised the error — never a catalog key.
			return props.error.message || t("shell.error.unexpected");
	}
});
</script>

<template>
	<div class="min-h-screen bg-bg-base flex flex-col">
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<NuxtLink to="/" class="font-display text-2xl text-text-primary">Owlat</NuxtLink>
		</nav>

		<main class="flex-1 flex flex-col items-center justify-center px-6 text-center">
			<p class="text-7xl font-display italic text-brand mb-4">{{ error.statusCode }}</p>
			<h1 class="text-2xl font-medium tracking-tight text-text-primary mb-3">
				{{
					error.statusCode === 404
						? t("shell.error.headingNotFound")
						: t("shell.error.headingGeneric")
				}}
			</h1>
			<p class="text-text-secondary mb-8 max-w-md">
				{{ statusMessage }}
			</p>
			<div class="flex gap-4">
				<UiButton class="px-6 py-2.5" @click="handleGoBack">{{ t("shell.error.goHome") }}</UiButton>
			</div>
		</main>
	</div>
</template>
