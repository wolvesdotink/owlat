<template>
	<footer class="border-t border-border-subtle">
		<div
			class="max-w-[1400px] mx-auto px-8 max-md:px-5 py-8 flex flex-col sm:flex-row items-center justify-between gap-4"
		>
			<!-- Edit link -->
			<a
				:href="editUrl"
				target="_blank"
				rel="noopener noreferrer"
				class="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast)"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
					/>
				</svg>
				{{ t('footer.editOnGitHub') }}
			</a>

			<!-- Copyright -->
			<p class="text-sm text-text-disabled">
				<I18nT keypath="footer.copyright" tag="span" scope="global">
					<template #year>{{ new Date().getFullYear() }}</template>
					<template #company><a href="https://wolves.ink">Wolves</a></template>
				</I18nT>
			</p>
		</div>
	</footer>
</template>

<script setup lang="ts">
const { t, locale } = useI18n();
const route = useRoute();

// The edit link points at the file that produced THIS page: the locale's own
// mirror under `content/<locale>/`. It is a `.../edit/...` URL, so it also
// works as "start this translation" for a German page that does not exist yet —
// GitHub opens the file creation flow.
const editUrl = computed(() => {
	const path = contentPath(route.path, locale.value);
	const file = path === '/' ? '/index' : path;
	return `https://github.com/wolvesdotink/owlat/edit/main/apps/docs/content/${locale.value}${file}.md`;
});
</script>
