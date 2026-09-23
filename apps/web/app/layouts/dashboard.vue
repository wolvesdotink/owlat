<script setup lang="ts">
import { announcedPageLabel, shouldMoveFocusToMain } from '~/utils/liveAnnounce';
import { useSectionNavigation } from '~/composables/useSectionNavigation';
import { CORE_NAV_HREFS } from '~/lib/dashboardNavigationCore';

const { t } = useI18n();
const route = useRoute();

// Initialize keyboard shortcuts
const { registerNavigationShortcuts } = useKeyboardShortcuts();

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
const isCollapsed = computed(() => (activeSection.value ? false : preferredCollapsed.value));
const showSectionNavigation = computed(() => !!activeSection.value && !showAppNavigation.value);
const sectionNavigationTarget = ref<HTMLElement | null>(null);
provide('section-navigation-target', sectionNavigationTarget);

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

// Focus mode state for distraction-free editing
const { isFocusMode } = useFocusMode();

// Desktop runtime — gates the workspace switcher rail + native chrome.
const { isDesktop, isMac, isWindows } = useDesktopContext();

// ⌘1–9 workspace switching (desktop only). Native application-menu actions are
// bridged app-wide by plugins/1.desktop-menu.client.ts, not here — the menu
// must also work on pre-workspace screens that never mount this layout.
useWorkspaceHotkeys();

// Native window material (macOS vibrancy / Windows 11 Mica). Behind a single flag
// so it can be killed without a config rebuild; the branded chrome and menus do
// not depend on it. The `.vibrancy-on` class (added only on success) gates the CSS
// in assets/css/desktop.css that makes the sidebar translucent — so an unsupported
// platform (e.g. Windows 10) can never reveal the desktop wallpaper.
const ENABLE_VIBRANCY = true;
onMounted(async () => {
	if (!ENABLE_VIBRANCY || !isDesktop.value || !(isMac.value || isWindows.value)) return;
	try {
		const { applyVibrancy } = await import('@owlat/desktop/src/window');
		await applyVibrancy(isWindows.value ? 'mica' : 'sidebar');
		document.documentElement.classList.add('vibrancy-on');
	} catch {
		// Unsupported (e.g. Windows 10) or Tauri unavailable — solid theme stays.
	}
});

onMounted(() => {
	registerNavigationShortcuts();
	initFromStorage();
});

// ── Route changes, said out loud ──────────────────────────────────────────
// A client-side navigation is INVISIBLE to assistive technology. The browser
// announces a real page load; a router that swaps the DOM under <main> announces
// nothing, and keyboard focus is left standing on the rail link that was just
// activated — several dozen tab stops away from the page it loaded. Two lines
// of repair, both standard: say the new page's name into the app's live region,
// and move focus into <main> (whose `tabindex="-1"` has been sitting below,
// unfocused by anything, since it was added for the skip link).
//
// `route.path`, not `fullPath`: a query change is a filter or a sort, not a new
// page, and re-announcing the same page name on every keystroke of a search box
// is worse than saying nothing.
const { announce } = useAnnounce();
const { breadcrumbs } = useBreadcrumbs();

watch(
	() => route.path,
	async () => {
		// The new page has to be rendered before its trail is right and before
		// asking where focus ended up.
		await nextTick();
		const label = announcedPageLabel(breadcrumbs.value);
		// Trail labels are message keys from the route registries and plain text
		// when a page supplied one dynamically; `t` passes the latter through.
		if (label) announce(t('shell.dashboard.navigatedTo', { page: t(label) }));
		if (shouldMoveFocusToMain(document.activeElement)) {
			// `preventScroll`: the router has already restored the scroll position,
			// and focusing a full-height <main> would undo it.
			document.getElementById('main-content')?.focus({ preventScroll: true });
		}
	}
);

// Native macOS traffic lights follow the sidebar (desktop + macOS only). They
// stay visible whenever the rail — or its transient peek overlay — is on screen,
// and hide only when the sidebar is fully hidden and not peeking. Wired at mount
// (after the webview is ready) with an immediate sync, so the buttons are never
// stranded: a fresh launch with a persisted-hidden sidebar re-hides them, and
// un-hiding the rail always brings them back.
//
// Fullscreen: macOS owns the buttons in native fullscreen (they live in the
// auto-revealed menu bar), so we restore them to visible on enter — don't fight
// the OS — and re-apply the sidebar-derived state on exit, since Cmd-\ toggles
// that happen inside fullscreen are dropped by the native guard and would
// otherwise leave the lights stale (visible with the rail hidden).
//
// Unmount: leaving this layout with the sidebar hidden (sign-out, session
// expiry → login) would strand the window with no close/miniaturize/zoom
// buttons on a surface that has no rail or peek to bring them back, so restore
// them whenever the sidebar-owning layout is torn down.
onMounted(() => {
	if (!isDesktop.value || !isMac.value) return;

	let unlistenFullscreen: (() => void) | null = null;
	let isFullscreen = false;

	// Reflect the current sidebar/peek state to the native buttons, unless the
	// window is in fullscreen (macOS owns them there — leave native behavior).
	const applySidebarState = async () => {
		if (isFullscreen) return;
		try {
			const { setTrafficLightsVisible, trafficLightsVisibleFor } =
				await import('@owlat/desktop/src/window');
			await setTrafficLightsVisible(
				trafficLightsVisibleFor(effectiveHidden.value, isPeeking.value)
			);
		} catch {
			// Tauri unavailable — native buttons stay as-is.
		}
	};

	watch([effectiveHidden, isPeeking], applySidebarState, { immediate: true });

	void (async () => {
		try {
			const { setTrafficLightsVisible, watchFullscreen } =
				await import('@owlat/desktop/src/window');
			unlistenFullscreen = await watchFullscreen((fullscreen) => {
				isFullscreen = fullscreen;
				if (fullscreen) {
					// Restore the buttons so the native fullscreen reveal bar shows the
					// green-button exit affordance; the native side then owns them.
					void setTrafficLightsVisible(true);
				} else {
					// Back to windowed — re-derive from the (possibly changed) sidebar.
					void applySidebarState();
				}
			});
		} catch {
			// Tauri unavailable — fullscreen tracking is a no-op.
		}
	})();

	onUnmounted(async () => {
		unlistenFullscreen?.();
		try {
			const { setTrafficLightsVisible } = await import('@owlat/desktop/src/window');
			await setTrafficLightsVisible(true);
		} catch {
			// Tauri unavailable — nothing to restore.
		}
	});
});

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

// Cmd/Ctrl-\ toggles the sidebar's hidden mode (desktop only; the composable
// guards the breakpoint), Cmd/Ctrl-, opens Settings, and Cmd/Ctrl-J opens the
// Assistant for every member while the feature is on. Registered alongside the
// other global shortcuts.
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
onMounted(() => {
	const handleToggleHidden = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
			e.preventDefault();
			toggleHidden();
		}
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ',') {
			e.preventDefault();
			void navigateTo('/dashboard/preferences');
		}
		if (
			(e.metaKey || e.ctrlKey) &&
			!e.shiftKey &&
			!e.altKey &&
			e.key.toLowerCase() === 'j' &&
			isFeatureEnabled('ai.assistant')
		) {
			e.preventDefault();
			void navigateTo('/dashboard/assistant');
		}
	};
	document.addEventListener('keydown', handleToggleHidden);
	onUnmounted(() => document.removeEventListener('keydown', handleToggleHidden));
});

// Peek overlay: open on left-edge hover, close 300ms after the pointer leaves
// (cancelled if it returns), or immediately on Esc / focus leaving the rail.
const peekCloseTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const cancelPeekClose = () => {
	if (peekCloseTimer.value !== null) {
		clearTimeout(peekCloseTimer.value);
		peekCloseTimer.value = null;
	}
};
const schedulePeekClose = () => {
	cancelPeekClose();
	peekCloseTimer.value = setTimeout(() => {
		closePeek();
		peekCloseTimer.value = null;
	}, 300);
};
const onPeekPointerEnter = () => {
	cancelPeekClose();
	openPeek();
};
const onPeekPointerLeave = () => {
	// Only meaningful while a peek is open; ignore ordinary visible/collapsed leaves.
	if (!isPeeking.value) return;
	schedulePeekClose();
};
// Focus leaving the peeked rail (Tab out / click away) closes it.
const onPeekFocusOut = (e: FocusEvent) => {
	const next = e.relatedTarget as Node | null;
	const current = e.currentTarget as HTMLElement | null;
	if (!current || (next && current.contains(next))) return;
	closePeek();
};
// Esc closes the peek without un-hiding the sidebar.
const onPeekKeydown = (e: KeyboardEvent) => {
	if (e.key === 'Escape' && isPeeking.value) {
		e.stopPropagation();
		closePeek();
	}
};
onUnmounted(cancelPeekClose);

// Mobile sidebar state
const isSidebarOpen = ref(false);

// The sidebar renders one workspace at a time (Conversations ↔ Marketing). The
// toggle is emergent: it only exists while both workspaces survived the flags.
const { showToggle, activeContext, sidebarSections, switchContext } = useSidebarContext();

// Frozen at setup, so `label` holds a MESSAGE KEY the template resolves rather
// than a sentence captured in whatever locale was active at mount.
const sidebarContexts = [
	{ key: 'inbox', label: 'shell.dashboard.contexts.inbox', icon: 'lucide:messages-square' },
	{ key: 'marketing', label: 'shell.dashboard.contexts.marketing', icon: 'lucide:megaphone' },
] as const;

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

// Initialize desktop notifications (no-op in browser)
useDesktopNotifications();

// "You can send now" — one in-app toast for a member whose onboarding first-send
// step was blocked while the instance had no outbound transport.
useSendReadyNotice();

// Quick Query used to be a second modal with its own Cmd/Ctrl+Shift+K handler
// and its own open event. Both now live in `AppCommandPalette`, which opens
// pre-switched to its Ask scope behind the same `ai.knowledge` gate — one
// overlay, one shortcut owner, and knowledge answers next to object results.

// The collapse control's one label.
const sidebarToggleLabel = computed(() => {
	return isCollapsed.value
		? t('shell.dashboard.expandSidebar')
		: t('shell.dashboard.collapseSidebar');
});

// Computed sidebar width class — a hidden sidebar peeks at its last width.
const sidebarWidthClass = computed(() => {
	return isCollapsed.value ? 'w-16' : 'w-64';
});

// Content padding reserves the rail's gutter. When hidden the content goes
// full-bleed (no reflow when the peek floats over it).
const mainPaddingClass = computed(() => {
	if (effectiveHidden.value) return '';
	return isCollapsed.value ? 'lg:pl-16' : 'lg:pl-64';
});

// Desktop transform for the aside. When hidden it slides off-screen; the peek
// brings it back over the content (no reflow — padding stays removed). Enter
// uses the spring-bounce at motion-slow; exit uses ease-exit. Reduced-motion is
// handled by the global floor in base.css (durations collapse to ~0).
const sidebarDesktopClass = computed(() => {
	if (!effectiveHidden.value) {
		return 'lg:translate-x-0 duration-(--motion-moderate)';
	}
	return isPeeking.value
		? 'lg:translate-x-0 shadow-(--shadow-6) duration-(--motion-slow) ease-(--ease-spring-bounce)'
		: 'lg:-translate-x-full duration-(--motion-slow-exit) ease-(--ease-exit)';
});
</script>

<template>
	<div class="min-h-dvh bg-bg-base" :class="{ 'has-desktop-chrome': isDesktop }">
		<!-- Skip link: first tab stop, visible only when focused -->
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--z-overlay) focus:px-4 focus:py-2 focus:bg-bg-elevated focus:border focus:border-brand focus:rounded-lg focus:text-text-primary"
		>
			{{ t('shell.dashboard.skipToContent') }}
		</a>

		<!-- Native window titlebar (desktop only; no-op on web). `show-search`:
		     this layout mounts <AppCommandPalette> below, so the pill has a
		     listener. -->
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
				'fixed top-0 left-0 z-50 h-full bg-bg-elevated border-r border-border-subtle flex flex-col transition-all pt-[env(safe-area-inset-top)] lg:pt-0',
				sidebarWidthClass,
				isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
				isFocusMode ? 'lg:-translate-x-full duration-(--motion-moderate)' : sidebarDesktopClass,
			]"
			:inert="effectiveHidden && !isPeeking ? true : undefined"
			@mouseenter="onPeekPointerEnter"
			@mouseleave="onPeekPointerLeave"
			@focusout="onPeekFocusOut"
			@keydown="onPeekKeydown"
		>
			<!-- Logo — web only. On desktop the app identity lives in the native
			     window chrome and the titlebar; the workspace (org) switcher is the
			     titlebar chip, so the sidebar carries navigation only. -->
			<div
				v-if="!isDesktop"
				class="h-16 flex items-center justify-between px-4 border-b border-border-subtle"
			>
				<NuxtLink
					to="/dashboard"
					class="flex items-center gap-2"
					:class="{ 'justify-center w-full': isCollapsed }"
				>
					<div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
						<img src="/owlat.svg" alt="Owlat" class="w-8 h-8 dark:invert" />
					</div>
					<span v-if="!isCollapsed" class="text-lg font-semibold text-text-primary"> Owlat </span>
					<UiBadge v-if="!isCollapsed" size="sm">{{ t('shell.dashboard.alphaBadge') }}</UiBadge>
				</NuxtLink>

				<!-- Mobile close button -->
				<button
					v-if="!isCollapsed"
					class="lg:hidden p-2 text-text-secondary hover:text-text-primary"
					@click="isSidebarOpen = false"
					:aria-label="t('common.close')"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>

			<!-- Context toggle: the sidebar shows one context at a time (Inbox ↔
			     Marketing) so it stays focused on the current work. Emergent: only
			     rendered while both contexts survived the feature flags. Switching
			     navigates to the target context's last-visited route. -->
			<div
				v-if="showToggle && !showSectionNavigation"
				class="px-2 pt-3"
				role="group"
				:aria-label="t('shell.dashboard.sidebarContextGroup')"
			>
				<div :class="isCollapsed ? 'flex flex-col gap-1' : 'flex gap-1'">
					<button
						v-for="context in sidebarContexts"
						:key="context.key"
						type="button"
						:aria-pressed="activeContext === context.key"
						:class="[
							'flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors',
							isCollapsed ? 'p-2' : 'flex-1 px-2 py-1.5',
							activeContext === context.key
								? 'bg-(--surface-2-selected) text-text-primary'
								: 'text-text-secondary hover:text-text-primary hover:bg-(--surface-2-hover)',
						]"
						:title="isCollapsed ? t(context.label) : undefined"
						@click="switchContext(context.key)"
					>
						<Icon
							:name="context.icon"
							:class="[
								isCollapsed ? 'w-5 h-5' : 'w-3.5 h-3.5',
								activeContext === context.key ? 'text-text-primary' : 'text-text-tertiary',
							]"
						/>
						<span v-if="!isCollapsed">{{ t(context.label) }}</span>
					</button>
				</div>
			</div>

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

			<!-- Collapse toggle button: one preference, the same on every page. -->
			<div v-if="!activeSection" class="hidden lg:flex px-2 py-1 border-t border-border-subtle">
				<button
					:class="[
						'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full',
						'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
						{ 'justify-center': isCollapsed },
					]"
					:title="sidebarToggleLabel"
					@click="toggleCollapsed"
				>
					<Icon
						:name="isCollapsed ? 'lucide:panel-left' : 'lucide:panel-left-close'"
						class="w-5 h-5 text-text-tertiary"
					/>
					<span v-if="!isCollapsed">{{ sidebarToggleLabel }}</span>
				</button>
			</div>

			<ShellSidebarFooter :collapsed="isCollapsed" />
		</aside>

		<!-- Main content area -->
		<div
			:class="isFocusMode ? '' : mainPaddingClass"
			class="transition-all duration-(--motion-moderate)"
		>
			<DashboardShellHeader
				v-if="!isFocusMode"
				:is-desktop="isDesktop"
				:navigation-open="isSidebarOpen"
				:navigation-hidden="effectiveHidden"
				@open-navigation="effectiveHidden ? toggleHidden() : (isSidebarOpen = true)"
				@open-search="openCommandPalette()"
			/>

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
						? 'min-h-[calc(100dvh-var(--titlebar-h,0px))]'
						: 'min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem-2.25rem-1px)] lg:min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem)]'
				"
			>
				<slot />
			</main>
		</div>

		<!-- App-wide command palette (Cmd/Ctrl-K), route-scoped: mail search on
		     Postbox, knowledge Ask on Cmd/Ctrl+Shift+K, objects everywhere else -->
		<AppCommandPalette />

		<!-- Compose over the current page (the top-bar button, the palette and
		     the c chord), never by navigating to the mailbox. -->
		<ShellComposerOverlay />

		<!-- Keyboard shortcuts help modal -->
		<KeyboardShortcutsHelp />

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
