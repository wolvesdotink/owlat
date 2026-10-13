<script setup lang="ts">
import { formatChord } from '~/utils/shortcutRegistry';
import { useZenMode } from '~/composables/useZenMode';

defineProps<{ isDesktop: boolean; navigationOpen?: boolean; navigationHidden?: boolean }>();
const emit = defineEmits<{ openNavigation: []; openSearch: [] }>();

const { t } = useI18n();
const { enterZen } = useZenMode();
const { platform } = useDesktopContext();
const zenChord = computed(() =>
	formatChord('mod+shift+F', import.meta.client && platform.value === 'mac').join('+')
);
</script>

<template>
	<header
		class="hidden lg:flex h-16 items-center justify-between px-6 border-b border-border-subtle bg-bg-elevated"
	>
		<button
			v-if="navigationHidden"
			type="button"
			class="mr-3 flex size-8 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			:aria-label="t('components.dashboard.dashboardShellHeader.openNavigation')"
			@click="emit('openNavigation')"
		>
			<Icon name="lucide:panel-left" class="size-4" />
		</button>
		<div class="flex-1 min-w-0 mr-4">
			<Breadcrumbs hide-shallow />
		</div>
		<div class="flex items-center gap-2 flex-shrink-0">
			<!-- The create action, persistent: one click from every page. -->
			<DashboardQuickCreateMenu />
			<GlobalSearch v-if="!isDesktop" />
			<button
				type="button"
				data-testid="zen-enter"
				class="flex size-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:title="`${t('components.shell.zen.enter')} (${zenChord})`"
				:aria-label="t('components.shell.zen.enter')"
				@click="enterZen"
			>
				<Icon name="lucide:maximize-2" class="size-4" />
			</button>
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
						<img src="/owlat.svg" alt="Owlat" class="w-8 h-8 dark:invert" />
					</div>
					<span class="text-lg font-semibold text-text-primary">Owlat</span>
				</NuxtLink>
			</div>

			<div class="flex items-center">
				<button
					class="p-2 rounded-xl text-text-secondary transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('common.search')"
					@click="emit('openSearch')"
				>
					<Icon name="lucide:search" class="w-5 h-5" />
				</button>
				<button
					class="p-2 rounded-xl text-text-secondary transition-colors duration-(--motion-fast) hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					:aria-label="t('components.shell.zen.enter')"
					@click="enterZen"
				>
					<Icon name="lucide:maximize-2" class="w-5 h-5" />
				</button>
			</div>
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
	     travels down so the bar can step aside for the drawer. -->
	<DashboardMobileTabBar :navigation-open="navigationOpen" />
</template>
