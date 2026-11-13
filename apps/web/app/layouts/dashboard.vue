<script setup lang="ts">
import { useSectionNavigation } from '~/composables/useSectionNavigation';
import { CORE_NAV_HREFS } from '~/lib/dashboardNavigationCore';
import { UNDO_TOAST_REGION_ID } from '~/utils/undoToastRegion';
import type { ShellPageBoundaryKey } from '~/lib/pageBoundary';
import AppErrorBoundary from '~/components/AppErrorBoundary.vue';
import { useCommandPaletteHost } from '~/composables/useCommandPaletteHost';
import { useMountOnFirst } from '~/composables/useMountOnFirst';
import { usePerfMark } from '~/composables/usePerfMark';
import { useRouteAnnounce } from '~/composables/shell/useRouteAnnounce';
import { useShellFocusMode } from '~/composables/shell/useShellFocusMode';
import { useShellNotices } from '~/composables/shell/useShellNotices';
import { useShellSidebarLayout } from '~/composables/shell/useShellSidebarLayout';
import { useShellWindowChrome } from '~/composables/shell/useShellWindowChrome';
import { useSidebarPeek } from '~/composables/shell/useSidebarPeek';
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';

const { t } = useI18n();
const route = useRoute();

// Initialize keyboard shortcuts
const { registerNavigationShortcuts, registerShortcut, isHelpModalOpen } = useKeyboardShortcuts();

// The palette and the "?" sheet stay off the boot path: each mounts the first
// time it is asked for, and stays mounted after that.
const { paletteRequested, paletteInitialOpen, onPaletteReady } = useCommandPaletteHost();
const helpRequested = useMountOnFirst(isHelpModalOpen);

// Feed this user's keyboard map (preset + their own remaps) into the shortcut
// registry, so every surface below dispatches and documents the same chords.
useShortcutPreferences();

// Sidebar state management. `effectiveCollapsed` — not the raw persisted
// `isCollapsed` — is what this shell renders against, exactly as it renders
// against `effectiveHidden`: below the desktop breakpoint the aside is the
// mobile drawer, and a collapse preference saved on a laptop must not turn it
// into a 64px icon strip there. Aliased so every reference below reads the
// resolved value.
const {
	effectiveCollapsed: preferredCollapsed,
	effectiveHidden,
	isPeeking,
	toggleCollapsed,
	toggleHidden,
	openPeek,
	closePeek,
	setDesktopViewport,
	initFromStorage,
} = useSidebarState();

// A section lends its existing navigation to this sidebar on desktop.
const { activeSection, showAppNavigation } = useSectionNavigation();
const {
	isCollapsed,
	onToggleCollapse,
	sidebarToggleLabel,
	sidebarWidthClass,
	mainPaddingClass,
	sidebarDesktopClass,
} = useShellSidebarLayout({
	preferredCollapsed,
	toggleCollapsed,
	effectiveHidden,
	isPeeking,
	activeSection,
});
const showSectionNavigation = computed(() => !!activeSection.value && !showAppNavigation.value);
const sectionNavigationTarget = ref<HTMLElement | null>(null);
provide('section-navigation-target', sectionNavigationTarget);
// Handed down from this lazy layout chunk to keep the boundary out of the
// entry bundle (see ShellPageBoundaryKey).
provide('owlat:shell-page-boundary' satisfies ShellPageBoundaryKey, AppErrorBoundary);

// Settings' Back returns to the last page of real work, however many settings
// pages were visited in between.
const settingsReturnTo = useState<string | null>('settings-return-to', () => null);
const isSettingsPath = (path: string) =>
	path.startsWith('/dashboard/preferences') || path.startsWith('/dashboard/admin');

watch(
	() => route.path,
	(path) => {
		showAppNavigation.value = false;
		if (!isSettingsPath(path)) settingsReturnTo.value = route.fullPath;
	},
	{ immediate: true }
);

// Keep the current destination visible in long settings trees.
async function revealCurrentSection() {
	if (!showSectionNavigation.value) return;
	await nextTick();
	requestAnimationFrame(() => {
		sectionNavigationTarget.value
			?.querySelector('[aria-current="page"]')
			?.scrollIntoView({ block: 'nearest' });
	});
}
watch(
	[() => route.path, () => activeSection.value?.id, showSectionNavigation],
	revealCurrentSection
);
const removePageFinishHook = useNuxtApp().hooks.hook('page:finish', revealCurrentSection);
onBeforeUnmount(() => removePageFinishHook?.());

// Focus, Answer and Zen mode hide the sidebar and the shell header.
const {
	isAnswerMode,
	isFocusMode,
	pageOwnsEscape,
	showZenBar,
	shellChromeHeight,
	shellChromeMobileHeight,
} = useShellFocusMode(route);

// Desktop runtime — gates the workspace switcher rail + native chrome.
const { isDesktop, isMac, isWindows } = useDesktopContext();

// ⌘1–9 workspace switching (desktop only). Native application-menu actions are
// bridged app-wide by plugins/1.desktop-menu.client.ts, not here — the menu
// must also work on pre-workspace screens that never mount this layout.
useWorkspaceHotkeys();

// Native window material and the macOS traffic lights (desktop only).
useShellWindowChrome({ isDesktop, isMac, isWindows, effectiveHidden, isPeeking });

onMounted(() => {
	registerNavigationShortcuts();
	initFromStorage();
});

// Navigation start to the shell on screen, for cold loads only (plan 0.2).
const { measureBoot } = usePerfMark();
onMounted(() => measureBoot('owlat_boot_shell_ms'));

// A client-side navigation says the new page's name and moves focus into it.
useRouteAnnounce();

// Keep the sidebar's desktop-viewport flag in sync with the `lg` breakpoint so
// the hidden/peek behavior stays desktop-only (mobile keeps its off-canvas
// drawer). Mirrors Tailwind's `lg` = 1024px.
const isDesktopViewport = ref(true);
onMounted(() => {
	const mql = window.matchMedia('(min-width: 1024px)');
	const sync = () => {
		isDesktopViewport.value = mql.matches;
		setDesktopViewport(mql.matches);
	};
	sync();
	mql.addEventListener('change', sync);
	onUnmounted(() => mql.removeEventListener('change', sync));
});

// Hide/show the sidebar (desktop only; the composable guards the breakpoint),
// open Settings, and open the Assistant for every member while the feature is
// on. Catalog ids, so a remap on the shortcuts page moves them; as modifier
// chords they fire while a text field has focus, like the browser's own.
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
registerShortcut({ id: 'global.toggleSidebar', handler: toggleHidden });
registerShortcut({
	id: 'global.settings',
	handler: () => void navigateTo('/dashboard/preferences'),
});
registerShortcut({
	id: 'global.assistant',
	handler: () => void navigateTo('/dashboard/assistant'),
	// Inside Answer mode ⌘J belongs to the draft ("Draft with AI").
	when: () => isFeatureEnabled('ai.assistant') && !isAnswerMode.value,
});

const { onPeekPointerEnter, onPeekPointerLeave, onPeekFocusOut, onPeekKeydown } = useSidebarPeek({
	isPeeking,
	openPeek,
	closePeek,
});

// Mobile sidebar state
const isSidebarOpen = ref(false);
const sidebarRef = ref<HTMLElement | null>(null);

// Below lg the aside is an off-canvas drawer. Closed, it is only translated off
// screen, so it must also leave the tab order; open, it holds focus like a
// dialog, closes on Escape and hands focus back to the menu button.
const isMobileDrawerOpen = computed(() => isSidebarOpen.value && !isDesktopViewport.value);
const isSidebarInert = computed(
	() =>
		(effectiveHidden.value && !isPeeking.value) ||
		isFocusMode.value ||
		(!isDesktopViewport.value && !isSidebarOpen.value)
);
useModalFocus(sidebarRef, isMobileDrawerOpen, () => {
	isSidebarOpen.value = false;
});

// The sidebar renders one workspace at a time (Conversations ↔ Marketing). The
// toggle is emergent: it only exists while both workspaces survived the flags.
const { showToggle, activeContext, sidebarSections, switchContext } = useSidebarContext();

// Plugin-contributed destinations for the active workspace. Core destinations
// render as the workspace's own rows; anything a plugin adds is listed after.
const pluginItems = computed(() =>
	sidebarSections.value
		.filter((section) => section.key !== 'administration' && section.key !== 'preferences')
		.flatMap((section) => section.items)
		.filter((item) => !CORE_NAV_HREFS.has(item.href))
);

// Sidebar rows are Alt+1…9 jump targets (⌘1–9 is the desktop workspace switcher).
const appNavigationRef = ref<HTMLElement | null>(null);
useSidebarJumpHints(appNavigationRef);

// Close sidebar when the destination changes (mobile). The full path, because
// picking another mailbox only changes the query on the same inbox route.
watch(
	() => route.fullPath,
	() => {
		isSidebarOpen.value = false;
	}
);

// Focus mode forces the rail off-screen; close any open peek so it can't be
// left stranded (the hot-zone unmounts and the off-screen aside never fires
// mouseleave to run the close timer).
watch(isFocusMode, (active) => {
	if (active) closePeek();
});

// Search opens the app command palette. Desktop hides the header GlobalSearch in
// favour of the titlebar pill; the mobile button opens the palette through the
// shared control so the event name lives in one place.
const { open: openCommandPalette } = useCommandPalette();

// The unread badge, the desktop tray and the in-app notices.
useShellNotices();

// Quick Query has no modal, shortcut handler or open event of its own: it is
// `AppCommandPalette` opened pre-switched to its Ask scope behind the same
// `ai.knowledge` gate — one overlay, one shortcut owner, and knowledge answers
// next to object results.
</script>

<template>
	<div
		class="min-h-dvh bg-bg-base"
		:class="{ 'has-desktop-chrome': isDesktop }"
		:style="{
			'--shell-chrome-h': shellChromeHeight,
			'--shell-chrome-mobile-h': shellChromeMobileHeight,
		}"
	>
		<!-- --shell-chrome-h / --shell-chrome-mobile-h: the shell chrome around the
		     page, for full-height pages that size against it. --shell-chrome-h is
		     the lg-and-up value only (the 4rem bar): below lg the chrome also
		     holds the breadcrumb strip and the bottom bar, so a full-height page
		     must use --shell-chrome-mobile-h there, or it overflows the viewport
		     by that difference. In Zen it is the slim bar, in a chrome-less page 0. -->
		<!-- Skip link: first tab stop, visible only when focused -->
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-overlay) focus:px-4 focus:py-2 focus:bg-bg-elevated focus:border focus:border-brand focus:rounded-lg focus:text-text-primary"
		>
			{{ t('shell.dashboard.skipToContent') }}
		</a>

		<!-- Native window titlebar (desktop only; no-op on web). `show-search`:
		     this layout hosts <AppCommandPalette> below (mounted on first open),
		     so the pill has a listener. -->
		<DesktopTitlebar show-search />

		<!-- Fill the iOS notch / dynamic island area so scrolled content never peeks through above the header. -->
		<div
			class="fixed top-0 left-0 right-0 z-(--z-header) pointer-events-none bg-bg-elevated lg:hidden"
			style="height: env(safe-area-inset-top, 0px)"
		/>

		<!-- Mobile sidebar overlay -->
		<Transition
			enter-active-class="transition-opacity duration-(--motion-moderate)"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-(--motion-moderate-exit)"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="isSidebarOpen"
				class="fixed inset-0 bg-scrim/50 z-(--z-modal) lg:hidden"
				@click="isSidebarOpen = false"
			/>
		</Transition>

		<!-- Left-edge hot-zone: opens the peek overlay while the sidebar is hidden.
		     Invisible 6px strip, desktop-only (only rendered when effectively hidden). -->
		<div
			v-if="effectiveHidden && !isPeeking && !isFocusMode"
			class="hidden lg:block fixed top-0 left-0 z-40 w-1.5 h-full"
			aria-hidden="true"
			@mouseenter="onPeekPointerEnter"
		/>

		<!-- Sidebar -->
		<aside
			ref="sidebarRef"
			:class="[
				'fixed top-0 left-0 z-(--z-modal) h-full bg-bg-elevated border-r border-border-subtle flex flex-col transition-[translate,box-shadow] motion-reduce:transition-none pt-[env(safe-area-inset-top)] lg:pt-0',
				sidebarWidthClass,
				isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
				isFocusMode ? 'lg:-translate-x-full duration-(--motion-moderate)' : sidebarDesktopClass,
			]"
			:inert="isSidebarInert ? true : undefined"
			@mouseenter="onPeekPointerEnter"
			@mouseleave="onPeekPointerLeave"
			@focusout="onPeekFocusOut"
			@keydown="onPeekKeydown"
		>
			<!-- Logo and the mobile drawer's close button; web only. -->
			<ShellSidebarBrand
				v-if="!isDesktop"
				:collapsed="isCollapsed"
				@close="isSidebarOpen = false"
			/>

			<!-- Inbox ↔ Marketing, while both contexts survived the feature flags. -->
			<ShellSidebarContextToggle
				v-if="showToggle && !showSectionNavigation"
				:collapsed="isCollapsed"
				:active-context="activeContext"
				@switch="switchContext"
			/>

			<!-- Settings takes the sidebar over (its own nav, search and Back);
			     daily work never does. -->
			<div
				id="section-navigation"
				ref="sectionNavigationTarget"
				v-show="showSectionNavigation"
				class="section-navigation flex-1 min-h-0 overflow-y-auto"
				:aria-label="activeSection?.title"
			/>
			<nav
				id="app-navigation"
				v-show="!showSectionNavigation"
				class="flex-1 min-h-0 px-2 py-3 overflow-y-auto"
				:aria-label="t('shell.dashboard.appNavigation')"
			>
				<div ref="appNavigationRef">
					<ShellConversationsNav
						v-if="activeContext === 'inbox' || !showToggle"
						:collapsed="isCollapsed"
						:extra-items="pluginItems"
					/>
					<ShellMarketingNav v-else :collapsed="isCollapsed" :extra-items="pluginItems" />
				</div>
			</nav>

			<!-- Account, Settings and the collapse toggle share one row. The toggle
			     is one saved preference, except in the Postbox, where the rail
			     folds on its own and opening it holds for the session
			     (`onToggleCollapse`); a section that lends its navigation to the
			     rail keeps it expanded. -->
			<ShellSidebarFooter
				:collapsed="isCollapsed"
				:collapse-label="activeSection ? null : sidebarToggleLabel"
				@toggle-collapse="onToggleCollapse"
			/>
		</aside>

		<!-- Main content area -->
		<div :class="isFocusMode ? '' : mainPaddingClass">
			<DashboardShellHeader
				v-if="!isFocusMode"
				:is-desktop="isDesktop"
				:navigation-open="isSidebarOpen"
				:navigation-hidden="effectiveHidden"
				@open-navigation="effectiveHidden ? toggleHidden() : (isSidebarOpen = true)"
				@open-search="openCommandPalette()"
			/>

			<!-- Zen mode's chord, its Esc and, in Zen, the slim bar with "Exit Zen". -->
			<ShellZenExit :show-bar="showZenBar" :page-owns-escape="pageOwnsEscape" />

			<!-- Page content. The floor is "fill what the chrome leaves", and below
			     lg the chrome is taller than the 4rem bar: the mobile header also
			     carries the 2.25rem breadcrumb strip and its hairline. Counting only
			     the bar left every phone page ~37px taller than the viewport — a
			     screenful of nothing to scroll past at the bottom of every screen. -->
			<main
				id="main-content"
				tabindex="-1"
				:class="
					isFocusMode
						? 'min-h-[calc(100dvh-var(--titlebar-h,0px)-var(--shell-chrome-h))]'
						: 'min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem-2.25rem-1px)] lg:min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem)]'
				"
			>
				<!-- A page that fails to render falls back in here, inside the shell
				     (AppPageOutlet reads ShellPageBoundaryKey): the rail, the header
				     and the palette stay usable. -->
				<slot />
			</main>
		</div>

		<!-- App-wide command palette (Cmd/Ctrl-K), route-scoped: mail search on
		     Postbox, knowledge Ask on Cmd/Ctrl+Shift+K, objects everywhere else -->
		<LazyAppCommandPalette
			v-if="paletteRequested"
			:initial-open="paletteInitialOpen"
			@ready="onPaletteReady"
		/>

		<!-- Compose over the current page (the top-bar button, the palette and
		     the c chord), never by navigating to the mailbox. -->
		<ShellComposerOverlay />

		<!-- Files dragged onto a conversation: the hint, and the reply it opens. -->
		<ShellReplyDropHint />

		<!-- Where every undo countdown toast lands (mail send, review approve,
		     campaign send): one bottom-left column, so two live windows stack
		     instead of covering each other's Undo button. -->
		<!-- Above the phone's bottom bar (--ui-bottom-chrome-height) and on the
		     toast layer, so an Undo raised from inside a dialog stays reachable. -->
		<div
			:id="UNDO_TOAST_REGION_ID"
			class="fixed bottom-[calc(1rem+var(--ui-bottom-chrome-height,0px))] left-4 z-(--z-toast) flex max-w-[calc(100vw-2rem)] flex-col gap-2"
		/>
		<!-- A team draft's approve countdown: armed in Answer mode, it outlives
		     the page the reply leaves from. -->
		<AnswerReviewApproveUndoToast />

		<!-- An AI client's write waiting for approval, on every page but the
		     AI clients settings, which lists them all. -->
		<ShellMcpApprovalPrompt />

		<!-- Keyboard shortcuts help modal -->
		<LazyKeyboardShortcutsHelp v-if="helpRequested" />

		<!-- The app's one pair of live regions. Mounted last and never unmounted:
		     a region has to be in the document before the text lands in it, so
		     anything shorter-lived than the shell cannot host one. -->
		<AppLiveRegion />
	</div>
</template>

<style scoped>
/*
 * Desktop native chrome: inset the layout below the fixed <DesktopTitlebar>.
 * The titlebar is position:fixed, so the root gets top padding and the fixed
 * sidebar is pushed down to sit beneath it. Web (no .has-desktop-chrome) is
 * untouched. `--titlebar-h` is inherited from <html> (default in desktop.css;
 * on macOS the boot plugin overwrites it with the measured native height) —
 * deliberately NOT re-declared here, which would shadow that override.
 */
.has-desktop-chrome {
	padding-top: var(--titlebar-h, 44px);
}
.has-desktop-chrome > aside {
	top: var(--titlebar-h, 44px);
	height: calc(100% - var(--titlebar-h, 44px));
}
/* The teleported rail shares the shell's width and scroll container. */
.section-navigation :deep(> nav) {
	width: 100%;
	padding: 0.75rem;
}
.section-navigation :deep(> div) {
	width: 100%;
	padding: 0.75rem 0.5rem;
}
.section-navigation :deep(aside) {
	width: 100%;
	border-right: 0;
}
.section-navigation {
	animation: section-enter var(--motion-moderate) ease-out;
}
@keyframes section-enter {
	from {
		opacity: 0;
		transform: translateX(8px);
	}
	to {
		opacity: 1;
		transform: translateX(0);
	}
}
@media (prefers-reduced-motion: reduce) {
	.section-navigation {
		animation: none;
	}
}
</style>
