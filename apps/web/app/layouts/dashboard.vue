<script setup lang="ts">
import { useSectionNavigation } from '~/composables/useSectionNavigation';
import { CORE_NAV_HREFS } from '~/lib/dashboardNavigationCore';
import { UNDO_TOAST_REGION_ID } from '~/utils/undoToastRegion';
import type { ShellPageBoundaryKey } from '~/lib/pageBoundary';
import AppErrorBoundary from '~/components/AppErrorBoundary.vue';
import { useCommandPaletteHost } from '~/composables/useCommandPaletteHost';
import { useMountOnFirst } from '~/composables/useMountOnFirst';
import { usePerfMark } from '~/composables/usePerfMark';
import { useZenMode } from '~/composables/useZenMode';
import { useRouteAnnounce } from '~/composables/shell/useRouteAnnounce';
import { useShellSidebarLayout } from '~/composables/shell/useShellSidebarLayout';
import { useShellWindowChrome } from '~/composables/shell/useShellWindowChrome';
import { useSidebarPeek } from '~/composables/shell/useSidebarPeek';

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

// Focus mode state for distraction-free editing. Answer mode (a reply being
// written, `definePageMeta({ answerMode: true })`) takes the whole screen the
// same way, so both hide the sidebar and the shell header through one flag.
// Zen mode (useZenMode) is the app-wide version of the same: one task, no chrome.
const { isFocusMode: isEditorFocusMode } = useFocusMode();
const { isZen } = useZenMode();
const isAnswerMode = computed(() => route.meta.answerMode === true);
const isFocusMode = computed(() => isEditorFocusMode.value || isAnswerMode.value || isZen.value);
// Zen keeps one slim bar for its exit, except where the page is chrome-less on
// its own terms and brings its own way out.
const pageOwnsEscape = computed(() => isAnswerMode.value || isEditorFocusMode.value);
const showZenBar = computed(() => isZen.value && !pageOwnsEscape.value);
const shellChromeHeight = computed(() => {
	if (!isFocusMode.value) return '4rem';
	return showZenBar.value ? 'calc(2.75rem + env(safe-area-inset-top, 0px))' : '0px';
});
// Below lg the shell is taller: bar, breadcrumb strip, hairline and tab bar.
const shellChromeMobileHeight = computed(() =>
	isFocusMode.value
		? `calc(${shellChromeHeight.value} + env(safe-area-inset-bottom, 0px))`
		: 'calc(10.25rem + 1px + env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px))'
);

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
onMounted(() => {
	const mql = window.matchMedia('(min-width: 1024px)');
	const sync = () => setDesktopViewport(mql.matches);
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

// Close sidebar when route changes (mobile)
watch(
	() => route.path,
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

// Unread mail is read once and badged everywhere from the same count: the
// browser tab (title prefix + dotted favicon) and, in the desktop app, the
// dock/taskbar icon plus native notifications. The desktop app has no tab and
// paints the count natively, so the tab badge stays browser-only.
const unreadBadge = useUnreadBadge();
const { isDesktop: isDesktopApp } = useDesktopContext();
useTabBadge(() => (isDesktopApp.value ? null : unreadBadge.count.value));
useDesktopNotifications(unreadBadge);
// The opt-in alert chimes (armed replies, assignments, agent questions) read
// the same unread peek, in the browser and the desktop app alike.
useAlertSounds(unreadBadge);

// Campaign, delivery, automation and sending-domain notices: in-app toast
// everywhere, native notification on the desktop app.
useMarketingNotices();

// "You can send now" — one in-app toast for a member whose onboarding first-send
// step was blocked while the instance had no outbound transport.
useSendReadyNotice();

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
		     page, for full-height pages that size against it (from lg / below
		     lg). In Zen it is the slim bar, in a chrome-less page 0. -->
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
				class="fixed inset-0 bg-scrim/50 z-40 lg:hidden"
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
			:class="[
				'fixed top-0 left-0 z-50 h-full bg-bg-elevated border-r border-border-subtle flex flex-col transition-[translate,box-shadow] motion-reduce:transition-none pt-[env(safe-area-inset-top)] lg:pt-0',
				sidebarWidthClass,
				isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
				isFocusMode ? 'lg:-translate-x-full duration-(--motion-moderate)' : sidebarDesktopClass,
			]"
			:inert="(effectiveHidden && !isPeeking) || isFocusMode ? true : undefined"
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
		<div :id="UNDO_TOAST_REGION_ID" class="fixed bottom-4 left-4 z-50 flex flex-col gap-2" />
		<!-- A team draft's approve countdown: armed in Answer mode, it outlives
		     the page the reply leaves from. -->
		<AnswerReviewApproveUndoToast />

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
