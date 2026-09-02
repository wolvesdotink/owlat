<script setup lang="ts">
defineProps<{ isDesktop: boolean; navigationOpen?: boolean }>();
const emit = defineEmits<{ openNavigation: []; openSearch: [] }>();

const { t } = useI18n();
</script>

<template>
	<header
		class="hidden lg:flex h-16 items-center justify-between px-6 border-b border-border-subtle bg-bg-elevated"
	>
		<div class="flex-1 min-w-0 mr-4">
			<Breadcrumbs />
		</div>
		<div class="flex items-center gap-3 flex-shrink-0">
			<!-- The create action, persistent: one click from every page. -->
			<DashboardQuickCreateMenu />
			<GlobalSearch v-if="!isDesktop" />
		</div>
	</header>

	<header
		class="lg:hidden border-b border-border-subtle bg-bg-elevated pt-[env(safe-area-inset-top)]"
	>
		<div class="h-16 flex items-center justify-between px-4">
			<div class="flex items-center">
				<button
					class="p-2 rounded-xl text-text-secondary transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('components.dashboard.dashboardShellHeader.openNavigation')"
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
				class="p-2 rounded-xl text-text-secondary transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('common.search')"
				@click="emit('openSearch')"
			>
				<Icon name="lucide:search" class="w-5 h-5" />
			</button>
		</div>
		<!-- A stated height, not padding around a variable trail: the mobile
		     chrome is 4rem of bar + 2.25rem of crumbs, and the full-height panes
		     (chat, assistant) size themselves against that sum. -->
		<div class="h-9 flex items-center px-4 overflow-x-auto">
			<Breadcrumbs />
		</div>
	</header>

	<!-- The phone's primary verbs. It teleports itself to the bottom of the
	     viewport; it lives here so it appears and disappears with the rest of
	     the shell chrome (focus mode unmounts this component). The drawer state
	     travels down so the bar can step aside for the drawer it opens. -->
	<DashboardMobileTabBar
		:navigation-open="navigationOpen"
		@open-navigation="emit('openNavigation')"
	/>
</template>
