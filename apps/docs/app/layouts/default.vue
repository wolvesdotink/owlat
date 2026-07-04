<template>
	<div class="min-h-dvh bg-bg-base">
		<DocsHeader @toggle-sidebar="sidebarOpen = !sidebarOpen" />

		<!-- Reading progress bar -->
		<div class="reading-progress">
			<div class="reading-progress-bar" :style="{ transform: `scaleX(${progress})` }" />
		</div>

		<DocsSidebarMobile v-model:open="sidebarOpen" />
		<div class="max-w-[1400px] mx-auto flex">
			<aside
				class="hidden lg:block w-64 shrink-0 sticky overflow-y-auto border-r border-border-subtle py-6 px-4"
				style="
					top: calc(61px + env(safe-area-inset-top, 0px));
					height: calc(100dvh - 61px - env(safe-area-inset-top, 0px));
				"
			>
				<DocsSidebar />
			</aside>
			<main class="flex-1 min-w-0 px-8 py-8 max-md:px-5">
				<DocsBreadcrumb />
				<div class="max-w-3xl mx-auto">
					<slot />
				</div>
				<DocsPrevNext />
			</main>
			<aside
				class="hidden xl:block w-52 shrink-0 sticky overflow-y-auto py-6 px-4"
				style="
					top: calc(61px + env(safe-area-inset-top, 0px));
					height: calc(100dvh - 61px - env(safe-area-inset-top, 0px));
				"
			>
				<DocsToc :key="route.path" />
			</aside>
		</div>
		<DocsFooter />
	</div>
</template>

<script setup lang="ts">
const sidebarOpen = ref(false);
const { progress } = useReadingProgress();
const route = useRoute();
</script>
