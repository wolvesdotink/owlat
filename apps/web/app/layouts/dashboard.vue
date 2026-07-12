<script setup lang="ts">
import { logError } from '~/lib/runtimeLog';
import type { NavigationSection } from '~/composables/useDashboardNavigation';

const { user, signOut, isPending } = useAuth();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const route = useRoute();
const router = useRouter();

// Initialize keyboard shortcuts
const { registerNavigationShortcuts } = useKeyboardShortcuts();

// Sidebar state management
const {
	isCollapsed,
	effectiveHidden,
	isPeeking,
	sectionStates,
	toggleCollapsed,
	toggleHidden,
	toggleSection,
	openPeek,
	closePeek,
	setDesktopViewport,
	initFromStorage,
} = useSidebarState();

// Focus mode state for distraction-free editing
const { isFocusMode } = useFocusMode();

// Desktop runtime — gates the workspace switcher rail + native chrome.
const { isDesktop, isMac, isWindows } = useDesktopContext();

// ⌘1–9 workspace switching + native application-menu actions (desktop only).
useWorkspaceHotkeys();
useDesktopMenu();

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
// guards the breakpoint). Registered alongside the other global shortcuts.
onMounted(() => {
	const handleToggleHidden = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
			e.preventDefault();
			toggleHidden();
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

// User dropdown state
const isUserDropdownOpen = ref(false);
const userDropdownRef = ref<HTMLElement | null>(null);

// Navigation sections with items — filtered by feature flags (shared with the
// global command palette via useDashboardNavigation) and narrowed to the
// active sidebar context (Inbox ↔ Marketing) with shared sections appended.
// The toggle is emergent: it renders only while both contexts have sections.
const { showToggle, activeContext, sidebarSections, firstSharedKey, switchContext } =
	useSidebarContext();

const sidebarContexts = [
	{ key: 'inbox', label: 'Inbox', icon: 'lucide:inbox' },
	{ key: 'marketing', label: 'Marketing', icon: 'lucide:megaphone' },
] as const;

// Check if a route is active (exact or prefix match)
const isActiveRoute = (href: string) => {
	// For overview/index pages, use exact match
	if (href === '/dashboard/audience' || href === '/dashboard/settings') {
		return route.path === href;
	}
	if (href === '/dashboard/send') {
		// "Templates & blocks" owns the Send overview + template/blocks/media
		// surfaces, but NOT the transactional subtree (its own "Transactional" item).
		return (
			route.path === href ||
			(route.path.startsWith(href + '/') && !route.path.startsWith('/dashboard/send/transactional'))
		);
	}
	if (href === '/dashboard/delivery') {
		// Health owns only the section root; every other /dashboard/delivery/* page
		// (Setup + the infra config pages it links to) belongs to Setup.
		return route.path === href;
	}
	if (href === '/dashboard/delivery/setup') {
		return route.path.startsWith('/dashboard/delivery/');
	}
	if (href === '/dashboard/knowledge') {
		// Knowledge list + entry detail pages, but not the Graph subpage (its own item).
		return (
			route.path === href ||
			(route.path.startsWith(href + '/') && !route.path.startsWith('/dashboard/knowledge/graph'))
		);
	}
	return route.path.startsWith(href);
};

// Check if any item in a section is active
const isSectionActive = (section: NavigationSection) => {
	return section.items.some((item) => isActiveRoute(item.href));
};

// Get the overview route for a section
const getSectionOverviewRoute = (sectionKey: string) => {
	const routes: Record<string, string> = {
		inbox: '/dashboard/inbox',
		chat: '/dashboard/chat',
		assistant: '/dashboard/assistant',
		send: '/dashboard/send',
		delivery: '/dashboard/delivery',
		knowledge: '/dashboard/knowledge',
		audience: '/dashboard/audience',
		settings: '/dashboard/settings',
	};
	return routes[sectionKey] || '/dashboard';
};

// Handle section header click - navigate when collapsed, toggle when expanded
const handleSectionClick = (section: NavigationSection) => {
	if (isCollapsed.value) {
		router.push(getSectionOverviewRoute(section.key));
	} else {
		toggleSection(section.key);
	}
};

// Handle sign out
const handleSignOut = async () => {
	try {
		await signOut();
	} catch (e) {
		logError('Sign out failed:', e);
	}
};

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

// Close dropdowns when clicking outside
const handleClickOutside = (event: MouseEvent) => {
	if (userDropdownRef.value && !userDropdownRef.value.contains(event.target as Node)) {
		isUserDropdownOpen.value = false;
	}
};

onMounted(() => {
	document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
	document.removeEventListener('click', handleClickOutside);
});

// Get user initials for avatar
const userInitials = computed(() => {
	if (!user.value?.name) return '?';
	return user.value.name
		.split(' ')
		.map((n) => n[0])
		.join('')
		.toUpperCase()
		.slice(0, 2);
});

// Search opens the app command palette. Desktop hides the header GlobalSearch in
// favour of the titlebar pill; the mobile button opens the palette through the
// shared control so the event name lives in one place.
const { open: openCommandPalette } = useCommandPalette();

// Quick Query panel state
const isQuickQueryOpen = ref(false);

// Initialize desktop notifications (no-op in browser)
useDesktopNotifications();

// Live unread chat mention count for the Chat section badge.
// Only subscribe when the chat flag is on (the composable's query asserts the
// flag server-side; we also gate the subscription here to keep the network
// quiet when chat is disabled).
const chatMentionCount = computed(() => 0);
const chatMentions = isFeatureEnabled('chat') ? useChatMentions() : null;
const liveChatMentionCount = computed(() => chatMentions?.count.value ?? chatMentionCount.value);

// Live delivery-health roll-up for the Delivery section's status dot. Stays
// invisible while healthy; shows a warning/error dot with a title tooltip
// naming the worst offender otherwise.
const {
	isVisible: isDeliveryHealthVisible,
	reason: deliveryHealthReason,
	dotClass: deliveryHealthDotClass,
} = useDeliveryHealth();

// Register Quick Query keyboard shortcut (Cmd+Shift+K / Ctrl+Shift+K).
// Quick Query searches the knowledge graph, so it is gated on `ai.knowledge`
// just like the panel mount below — the shortcut must do nothing when knowledge
// is disabled (the backend mutation also asserts the flag).
onMounted(() => {
	const handleQuickQuery = (e: KeyboardEvent) => {
		if (!isFeatureEnabled('ai.knowledge')) return;
		// With Shift held the key value is uppercase — compare case-insensitively.
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			isQuickQueryOpen.value = !isQuickQueryOpen.value;
		}
	};
	document.addEventListener('keydown', handleQuickQuery);
	// The command palette surfaces Quick Query as its "Ask knowledge…" action,
	// which dispatches this event so the two share one open path.
	const handleOpenKnowledgeQuery = () => {
		if (!isFeatureEnabled('ai.knowledge')) return;
		isQuickQueryOpen.value = true;
	};
	window.addEventListener('owlat:open-knowledge-query', handleOpenKnowledgeQuery);
	onUnmounted(() => {
		document.removeEventListener('keydown', handleQuickQuery);
		window.removeEventListener('owlat:open-knowledge-query', handleOpenKnowledgeQuery);
	});
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
			Skip to main content
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
				class="fixed inset-0 bg-black/50 z-40 lg:hidden"
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
						<img src="/owlat.svg" alt="Owlat" class="w-8 h-8 text-brand" />
					</div>
					<span v-if="!isCollapsed" class="text-lg font-semibold text-text-primary"> Owlat </span>
				</NuxtLink>

				<!-- Mobile close button -->
				<button
					v-if="!isCollapsed"
					class="lg:hidden p-2 text-text-secondary hover:text-text-primary"
					@click="isSidebarOpen = false"
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</div>

			<!-- Context toggle: the sidebar shows one context at a time (Inbox ↔
			     Marketing) so it stays focused on the current work. Emergent: only
			     rendered while both contexts survived the feature flags. Switching
			     navigates to the target context's last-visited route. -->
			<div v-if="showToggle" class="px-2 pt-3" role="group" aria-label="Sidebar context">
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
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
						]"
						:title="isCollapsed ? context.label : undefined"
						@click="switchContext(context.key)"
					>
						<Icon
							:name="context.icon"
							:class="[
								isCollapsed ? 'w-5 h-5' : 'w-3.5 h-3.5',
								activeContext === context.key ? 'text-brand' : 'text-text-tertiary',
							]"
						/>
						<span v-if="!isCollapsed">{{ context.label }}</span>
					</button>
				</div>
			</div>

			<!-- Navigation with collapsible sections -->
			<nav class="flex-1 px-2 py-4 overflow-y-auto">
				<!-- Dashboard link (always visible) -->
				<div class="mb-2">
					<NuxtLink
						to="/dashboard"
						:class="[
							'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
							route.path === '/dashboard'
								? 'bg-brand-subtle text-brand'
								: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
							{ 'justify-center': isCollapsed },
						]"
						:title="isCollapsed ? 'Dashboard' : undefined"
					>
						<Icon
							name="lucide:layout-dashboard"
							:class="[
								'w-5 h-5 flex-shrink-0',
								route.path === '/dashboard' ? 'text-brand' : 'text-text-tertiary',
							]"
						/>
						<span v-if="!isCollapsed">Dashboard</span>
					</NuxtLink>
				</div>

				<!-- Collapsible sections — the active context's sections first, shared
				     sections (Assistant, Knowledge, Settings) after the divider -->
				<div class="space-y-1">
					<div v-for="section in sidebarSections" :key="section.key" class="mb-1">
						<div
							v-if="section.key === firstSharedKey"
							class="my-2 border-t border-border-subtle"
							aria-hidden="true"
						/>
						<!-- Flat section: a single link, no collapsible sub-list. Used when
						     the destination carries its own in-page navigation (Postbox's
						     folder rail) or the section has only one page (Chat, Assistant). -->
						<NuxtLink
							v-if="section.href"
							:to="section.href"
							:class="[
								'relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
								isActiveRoute(section.href)
									? 'bg-brand-subtle text-brand'
									: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
								{ 'justify-center': isCollapsed },
							]"
							:title="isCollapsed ? section.name : undefined"
						>
							<Icon
								:name="section.icon"
								:class="[
									'w-5 h-5 flex-shrink-0',
									isActiveRoute(section.href) ? 'text-brand' : 'text-text-tertiary',
								]"
							/>
							<span v-if="!isCollapsed" class="flex-1 text-left">{{ section.name }}</span>
							<!-- Chat mention badge: inline expanded; corner overlay collapsed. -->
							<span
								v-if="section.key === 'chat' && liveChatMentionCount > 0 && !isCollapsed"
								class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-error text-white"
								:title="`${liveChatMentionCount} unread mention${liveChatMentionCount === 1 ? '' : 's'}`"
							>
								{{ liveChatMentionCount > 99 ? '99+' : liveChatMentionCount }}
							</span>
							<span
								v-if="section.key === 'chat' && liveChatMentionCount > 0 && isCollapsed"
								class="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-error text-white text-[10px] leading-4 font-semibold text-center ring-2 ring-bg-elevated"
								:title="`${liveChatMentionCount} unread mention${liveChatMentionCount === 1 ? '' : 's'}`"
							>
								{{ liveChatMentionCount > 99 ? '99+' : liveChatMentionCount }}
							</span>
						</NuxtLink>

						<!-- Section header -->
						<button
							v-else
							:class="[
								'relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
								isSectionActive(section)
									? 'text-brand'
									: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
								{ 'justify-center': isCollapsed },
							]"
							:title="isCollapsed ? section.name : undefined"
							@click="handleSectionClick(section)"
						>
							<Icon
								:name="section.icon"
								:class="[
									'w-5 h-5 flex-shrink-0',
									isSectionActive(section) ? 'text-brand' : 'text-text-tertiary',
								]"
							/>
							<span v-if="!isCollapsed" class="flex-1 text-left">{{ section.name }}</span>
							<span
								v-if="section.key === 'chat' && liveChatMentionCount > 0"
								class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-error text-white"
								:title="`${liveChatMentionCount} unread mention${liveChatMentionCount === 1 ? '' : 's'}`"
							>
								{{ liveChatMentionCount > 99 ? '99+' : liveChatMentionCount }}
							</span>
							<!-- Delivery health dot: worst-of reputation / domains / provider.
							     Hidden while healthy. Expanded → inline; collapsed → corner overlay. -->
							<span
								v-if="section.key === 'delivery' && isDeliveryHealthVisible && !isCollapsed"
								class="w-2 h-2 rounded-full flex-shrink-0"
								:class="deliveryHealthDotClass"
								:title="deliveryHealthReason"
								:aria-label="deliveryHealthReason"
							/>
							<span
								v-if="section.key === 'delivery' && isDeliveryHealthVisible && isCollapsed"
								class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full ring-2 ring-bg-base"
								:class="deliveryHealthDotClass"
								:title="deliveryHealthReason"
								:aria-label="deliveryHealthReason"
							/>
							<Icon
								v-if="!isCollapsed"
								name="lucide:chevron-down"
								:class="[
									'w-4 h-4 text-text-tertiary transition-transform duration-(--motion-moderate)',
									sectionStates[section.key] ? '' : '-rotate-90',
								]"
							/>
						</button>

						<!-- Section items -->
						<Transition
							enter-active-class="transition-all duration-(--motion-moderate) ease-spring"
							enter-from-class="opacity-0 max-h-0"
							enter-to-class="opacity-100 max-h-96"
							leave-active-class="transition-all duration-(--motion-moderate-exit) ease-exit"
							leave-from-class="opacity-100 max-h-96"
							leave-to-class="opacity-0 max-h-0"
						>
							<ul
								v-if="!section.href && !isCollapsed && sectionStates[section.key]"
								class="mt-1 ml-4 space-y-0.5 overflow-hidden"
							>
								<li v-for="item in section.items" :key="item.name">
									<NuxtLink
										:to="item.href"
										:class="[
											'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
											isActiveRoute(item.href)
												? 'bg-brand-subtle text-brand font-medium'
												: 'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
										]"
									>
										<Icon
											:name="item.icon"
											:class="[
												'w-4 h-4',
												isActiveRoute(item.href) ? 'text-brand' : 'text-text-tertiary',
											]"
										/>
										{{ item.name }}
									</NuxtLink>
								</li>
							</ul>
						</Transition>
					</div>
				</div>
			</nav>

			<!-- Collapse toggle button -->
			<div class="hidden lg:flex px-2 py-2 border-t border-border-subtle">
				<button
					:class="[
						'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full',
						'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
						{ 'justify-center': isCollapsed },
					]"
					:title="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
					@click="toggleCollapsed"
				>
					<Icon
						v-if="!isCollapsed"
						name="lucide:panel-left-close"
						class="w-5 h-5 text-text-tertiary"
					/>
					<Icon v-else name="lucide:panel-left" class="w-5 h-5 text-text-tertiary" />
					<span v-if="!isCollapsed">Collapse</span>
				</button>
			</div>

			<!-- Theme toggle -->
			<div class="px-2 py-2 border-t border-border-subtle">
				<UiThemeToggle
					:class="[
						'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors w-full',
						'text-text-secondary hover:text-text-primary hover:bg-bg-surface',
						{ 'justify-center': isCollapsed },
					]"
				>
					<span v-if="!isCollapsed">Theme</span>
				</UiThemeToggle>
			</div>

			<!-- User Profile Dropdown -->
			<div ref="userDropdownRef" class="relative px-2 py-4 border-t border-border-subtle">
				<button
					:class="[
						'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-surface transition-colors',
						{ 'justify-center': isCollapsed },
					]"
					:title="isCollapsed ? user?.name || 'User' : undefined"
					@click="isUserDropdownOpen = !isUserDropdownOpen"
				>
					<!-- Avatar -->
					<div
						class="w-8 h-8 rounded-full bg-brand-subtle flex items-center justify-center text-sm font-medium text-brand flex-shrink-0"
					>
						{{ isPending ? '...' : userInitials }}
					</div>

					<!-- User info -->
					<div v-if="!isCollapsed" class="flex-1 text-left min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ isPending ? 'Loading...' : user?.name || 'User' }}
						</p>
						<p class="text-xs text-text-tertiary truncate">
							{{ isPending ? '' : user?.email || '' }}
						</p>
					</div>

					<!-- Chevron -->
					<Icon
						v-if="!isCollapsed"
						name="lucide:chevron-down"
						:class="[
							'w-4 h-4 text-text-tertiary transition-transform',
							isUserDropdownOpen ? 'rotate-180' : '',
						]"
					/>
				</button>

				<!-- Dropdown menu -->
				<Transition
					enter-active-class="transition-all duration-(--motion-moderate)"
					enter-from-class="opacity-0 translate-y-2"
					enter-to-class="opacity-100 translate-y-0"
					leave-active-class="transition-all duration-(--motion-moderate-exit)"
					leave-from-class="opacity-100 translate-y-0"
					leave-to-class="opacity-0 translate-y-2"
				>
					<div
						v-if="isUserDropdownOpen"
						:class="[
							'absolute bottom-full mb-2 bg-bg-surface border border-border-default rounded-lg shadow-lg overflow-hidden',
							isCollapsed ? 'left-2 right-2' : 'left-2 right-2',
						]"
					>
						<button
							class="w-full flex items-center gap-3 px-4 py-3 text-sm text-error hover:bg-error-subtle transition-colors"
							@click="handleSignOut"
						>
							<Icon name="lucide:log-out" class="w-4 h-4" />
							<span v-if="!isCollapsed">Sign out</span>
						</button>
					</div>
				</Transition>
			</div>
		</aside>

		<!-- Main content area -->
		<div
			:class="isFocusMode ? '' : mainPaddingClass"
			class="transition-all duration-(--motion-moderate)"
		>
			<!-- Desktop header with breadcrumbs and search (hidden in focus mode) -->
			<header
				v-if="!isFocusMode"
				class="hidden lg:flex h-16 items-center justify-between px-6 border-b border-border-subtle bg-bg-elevated"
			>
				<div class="flex-1 min-w-0 mr-4">
					<Breadcrumbs />
				</div>
				<!-- On desktop the native titlebar owns the ⌘K search affordance, so the
				     duplicate header search is dropped there; web keeps it. -->
				<div v-if="!isDesktop" class="flex-shrink-0">
					<GlobalSearch />
				</div>
			</header>

			<!-- Mobile header (hidden in focus mode) -->
			<header
				v-if="!isFocusMode"
				class="lg:hidden border-b border-border-subtle bg-bg-elevated pt-[env(safe-area-inset-top)]"
			>
				<div class="h-16 flex items-center justify-between px-4">
					<div class="flex items-center">
						<button
							class="p-2 text-text-secondary hover:text-text-primary"
							aria-label="Open navigation menu"
							@click="isSidebarOpen = true"
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

					<!-- Mobile search button -->
					<button
						class="p-2 text-text-secondary hover:text-text-primary"
						aria-label="Search"
						@click="openCommandPalette()"
					>
						<Icon name="lucide:search" class="w-5 h-5" />
					</button>
				</div>
				<!-- Mobile breadcrumbs -->
				<div class="px-4 pb-3 overflow-x-auto">
					<Breadcrumbs />
				</div>
			</header>

			<!-- Page content -->
			<main
				id="main-content"
				tabindex="-1"
				:class="
					isFocusMode
						? 'min-h-[calc(100dvh-var(--titlebar-h,0px))]'
						: 'min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem)] lg:min-h-[calc(100dvh-var(--titlebar-h,0px)-4rem-3rem)]'
				"
			>
				<slot />
			</main>

			<!-- Footer with system status (hidden in focus mode) -->
			<footer
				v-if="!isFocusMode"
				class="h-12 flex items-center justify-between px-4 lg:px-6 border-t border-border-subtle bg-bg-elevated"
			>
				<div class="flex items-center gap-4">
					<SystemStatusIndicator />
				</div>
				<div class="flex items-center gap-4 text-xs text-text-tertiary">
					<span class="hidden sm:inline">Owlat v1.0</span>
				</div>
			</footer>
		</div>

		<!-- Quick Query panel (knowledge search — gated on ai.knowledge) -->
		<QueryQuickQueryPanel
			v-if="isFeatureEnabled('ai.knowledge')"
			:is-open="isQuickQueryOpen"
			@close="isQuickQueryOpen = false"
		/>

		<!-- App-wide command palette (Cmd/Ctrl-K) — works on every dashboard page -->
		<AppCommandPalette />

		<!-- Keyboard shortcuts help modal -->
		<KeyboardShortcutsHelp />
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
.has-desktop-chrome aside {
	top: var(--titlebar-h, 44px);
	height: calc(100% - var(--titlebar-h, 44px));
}
</style>
