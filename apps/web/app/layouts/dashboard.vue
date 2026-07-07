<script setup lang="ts">
import { logError } from '~/lib/runtimeLog';

const { user, signOut, isPending } = useAuth();
const { organization, role: orgRole, isLoading: isOrgLoading } = useOrganizationContext();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// Get organization initials for avatar
const orgInitials = computed(() => {
	if (!organization.value?.name) return '?';
	return organization.value.name
		.split(' ')
		.map((n) => n[0])
		.join('')
		.toUpperCase()
		.slice(0, 2);
});
const route = useRoute();
const router = useRouter();

// Initialize keyboard shortcuts
const { registerNavigationShortcuts } = useKeyboardShortcuts();

// Sidebar state management
const { isCollapsed, sectionStates, toggleCollapsed, toggleSection, initFromStorage } =
	useSidebarState();

// Focus mode state for distraction-free editing
const { isFocusMode } = useFocusMode();

// Desktop runtime — gates the workspace switcher rail + native chrome.
const { isDesktop, isMac, isWindows } = useDesktopContext();

// Bridge global OS shortcuts (compose / quick-switcher) into the SPA.
useDesktopShortcuts();
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

// Mobile sidebar state
const isSidebarOpen = ref(false);

// User dropdown state
const isUserDropdownOpen = ref(false);
const userDropdownRef = ref<HTMLElement | null>(null);

// Navigation sections with items — filtered by feature flags. Shared with the
// global command palette via useDashboardNavigation so the two never drift.
const { navigationSections } = useDashboardNavigation();

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
const isSectionActive = (section: (typeof navigationSections.value)[0]) => {
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
const handleSectionClick = (section: (typeof navigationSections.value)[0]) => {
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

// Global search ref (single instance)
const globalSearchRef = ref<{ openSearch: () => void } | null>(null);

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

// Computed sidebar width class
const sidebarWidthClass = computed(() => {
	return isCollapsed.value ? 'w-16' : 'w-64';
});

const mainPaddingClass = computed(() => {
	return isCollapsed.value ? 'lg:pl-16' : 'lg:pl-64';
});
</script>

<template>
	<div class="min-h-dvh bg-bg-base" :class="{ 'has-desktop-chrome': isDesktop }">
		<!-- Skip link: first tab stop, visible only when focused -->
		<a
			href="#main-content"
			class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-bg-elevated focus:border focus:border-brand focus:rounded-lg focus:text-text-primary"
		>
			Skip to main content
		</a>

		<!-- Native window titlebar (desktop only; no-op on web). -->
		<DesktopTitlebar />

		<!-- Fill the iOS notch / dynamic island area so scrolled content never peeks through above the header. -->
		<div
			class="fixed top-0 left-0 right-0 z-[60] pointer-events-none bg-bg-elevated lg:hidden"
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

		<!-- Sidebar -->
		<aside
			:class="[
				'fixed top-0 left-0 z-50 h-full bg-bg-elevated border-r border-border-subtle flex flex-col transition-all duration-(--motion-moderate) pt-[env(safe-area-inset-top)] lg:pt-0',
				sidebarWidthClass,
				isSidebarOpen ? 'translate-x-0' : '-translate-x-full',
				isFocusMode ? '-translate-x-full' : 'lg:translate-x-0',
			]"
		>
			<!-- Desktop-only: Slack-style workspace switcher -->
			<DesktopWorkspaceSwitcher v-if="isDesktop" />

			<!-- Logo -->
			<div class="h-16 flex items-center justify-between px-4 border-b border-border-subtle">
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

			<!-- Organization Display -->
			<div class="relative px-2 py-3 border-b border-border-subtle">
				<div
					:class="[
						'flex items-center gap-3 px-3 py-2.5 rounded-lg',
						'bg-bg-surface/50 border border-border-subtle',
						{ 'justify-center': isCollapsed },
					]"
					:title="isCollapsed ? organization?.name || 'Organization' : undefined"
				>
					<!-- Organization Avatar -->
					<div
						class="w-8 h-8 rounded-lg bg-gradient-to-br from-brand/20 to-brand/5 border border-brand/20 flex items-center justify-center text-xs font-semibold text-brand flex-shrink-0"
					>
						<template v-if="isOrgLoading">
							<span class="animate-pulse">...</span>
						</template>
						<template v-else>
							{{ orgInitials }}
						</template>
					</div>

					<!-- Organization info -->
					<div v-if="!isCollapsed" class="flex-1 text-left min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ isOrgLoading ? 'Loading...' : organization?.name || 'Organization' }}
						</p>
						<p class="text-[11px] text-text-tertiary truncate capitalize">
							{{ orgRole || 'editor' }}
						</p>
					</div>
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

				<!-- Collapsible sections -->
				<div class="space-y-1">
					<div v-for="section in navigationSections" :key="section.key" class="mb-1">
						<!-- Section header -->
						<button
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
								v-if="!isCollapsed && sectionStates[section.key]"
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
				<div class="flex-shrink-0">
					<GlobalSearch ref="globalSearchRef" />
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
						@click="globalSearchRef?.openSearch()"
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
					isFocusMode ? 'min-h-screen' : 'min-h-[calc(100vh-4rem)] lg:min-h-[calc(100vh-4rem-3rem)]'
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
 * untouched.
 */
.has-desktop-chrome {
	--titlebar-h: 38px;
	padding-top: var(--titlebar-h);
}
.has-desktop-chrome aside {
	top: var(--titlebar-h);
	height: calc(100% - var(--titlebar-h));
}
</style>
