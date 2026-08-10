<script setup lang="ts">
defineProps<{ isDesktop: boolean }>();
const emit = defineEmits<{ openNavigation: []; openSearch: [] }>();
</script>

<template>
	<header
		class="hidden lg:flex h-16 items-center justify-between px-6 border-b border-border-subtle bg-bg-elevated"
	>
		<div class="flex-1 min-w-0 mr-4">
			<Breadcrumbs />
		</div>
		<div v-if="!isDesktop" class="flex-shrink-0">
			<GlobalSearch />
		</div>
	</header>

	<header
		class="lg:hidden border-b border-border-subtle bg-bg-elevated pt-[env(safe-area-inset-top)]"
	>
		<div class="h-16 flex items-center justify-between px-4">
			<div class="flex items-center">
				<button
					class="p-2 text-text-secondary hover:text-text-primary"
					aria-label="Open navigation menu"
					@click="emit('openNavigation')"
				>
					<Icon name="lucide:menu" class="w-6 h-6" />
				</button>

				<NuxtLink to="/dashboard" class="ml-3 flex items-center gap-2">
					<div class="w-8 h-8 rounded-lg flex items-center justify-center">
						<img src="/owlat.svg" alt="Owlat" class="w-8 h-8 text-brand" />
					</div>
					<span class="text-lg font-semibold text-text-primary">Owlat</span>
				</NuxtLink>
			</div>

			<button
				class="p-2 text-text-secondary hover:text-text-primary"
				aria-label="Search"
				@click="emit('openSearch')"
			>
				<Icon name="lucide:search" class="w-5 h-5" />
			</button>
		</div>
		<div class="px-4 pb-3 overflow-x-auto">
			<Breadcrumbs />
		</div>
	</header>
</template>
