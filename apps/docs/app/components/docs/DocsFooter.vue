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
				class="flex items-center gap-2 text-sm text-text-tertiary hover:text-brand transition-colors duration-(--motion-fast)"
			>
				<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
					/>
				</svg>
				Edit this page on GitHub
			</a>

			<!-- Copyright -->
			<p class="text-sm text-text-disabled">
				&copy; {{ new Date().getFullYear() }} <a href="https://wolves.ink">Wolves</a>. All rights
				reserved.
			</p>
		</div>
	</footer>
</template>

<script setup lang="ts">
const route = useRoute();

const editUrl = computed(() => {
	const path = route.path === '/' ? '/index' : route.path;
	return `https://github.com/wolvesdotink/owlat/edit/main/apps/docs/content${path}.md`;
});
</script>
