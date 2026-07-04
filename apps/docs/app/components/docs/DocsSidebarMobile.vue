<template>
	<Teleport to="body">
		<Transition name="sidebar-mobile">
			<div
				v-if="open"
				class="fixed inset-0 z-50 lg:hidden"
				@keydown.escape="emit('update:open', false)"
			>
				<!-- Backdrop -->
				<div
					class="absolute inset-0 bg-black/60 backdrop-blur-sm"
					@click="emit('update:open', false)"
				/>

				<!-- Panel -->
				<div
					class="absolute inset-y-0 left-0 w-72 bg-bg-base border-r border-border-default shadow-lg overflow-y-auto pt-[env(safe-area-inset-top)]"
				>
					<!-- Panel header -->
					<div
						class="flex items-center justify-between h-[60px] px-4 border-b border-border-subtle"
					>
						<NuxtLink
							to="/"
							class="flex items-center gap-2 text-text-primary"
							@click="emit('update:open', false)"
						>
							<svg
								class="w-6 h-6 text-brand"
								viewBox="0 0 28 28"
								fill="none"
								xmlns="http://www.w3.org/2000/svg"
							>
								<circle cx="14" cy="14" r="13" stroke="currentColor" stroke-width="1.5" />
								<circle cx="10" cy="12" r="2.5" fill="currentColor" />
								<circle cx="18" cy="12" r="2.5" fill="currentColor" />
								<path
									d="M10 18c1.5 1.5 6.5 1.5 8 0"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
								/>
							</svg>
							<span class="font-display text-lg">Owlat Docs</span>
						</NuxtLink>
						<button
							class="flex items-center justify-center w-8 h-8 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast)"
							aria-label="Close sidebar"
							@click="emit('update:open', false)"
						>
							<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
					</div>

					<!-- Mobile nav links -->
					<div class="px-4 py-3 border-b border-border-subtle">
						<NuxtLink
							v-for="link in mobileNavLinks"
							:key="link.to"
							:to="link.to"
							class="block px-2 py-2 text-sm rounded-lg transition-colors duration-(--motion-fast) text-text-secondary hover:text-text-primary hover:bg-bg-surface"
							@click="emit('update:open', false)"
						>
							{{ link.label }}
						</NuxtLink>
					</div>

					<!-- Sidebar navigation -->
					<div class="py-4 px-4">
						<DocsSidebar />
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<script setup lang="ts">
const props = defineProps<{
	open: boolean;
}>();

const emit = defineEmits<{
	'update:open': [value: boolean];
}>();

const mobileNavLinks = [
	{ label: 'Guide', to: '/guide/getting-started' },
	{ label: 'API', to: '/api' },
	{ label: 'Developer', to: '/developer' },
];

// Close sidebar on route change
const route = useRoute();
watch(
	() => route.path,
	() => {
		emit('update:open', false);
	}
);

// Lock body scroll when open
watch(
	() => props.open,
	(isOpen) => {
		if (import.meta.server) return;
		document.body.style.overflow = isOpen ? 'hidden' : '';
	}
);
</script>

<style scoped>
.sidebar-mobile-enter-active,
.sidebar-mobile-leave-active {
	transition: opacity var(--motion-moderate) var(--ease-spring);
}

.sidebar-mobile-enter-active > div:last-child,
.sidebar-mobile-leave-active > div:last-child {
	transition: transform var(--motion-moderate) var(--ease-spring);
}

.sidebar-mobile-enter-from,
.sidebar-mobile-leave-to {
	opacity: 0;
}

.sidebar-mobile-enter-from > div:last-child,
.sidebar-mobile-leave-to > div:last-child {
	transform: translateX(-100%);
}
</style>
