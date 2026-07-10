<script setup lang="ts">
/**
 * Native-feel window titlebar for the desktop app. Renders nothing on web.
 *
 * The bar earns its 38px: it carries the chrome the page used to duplicate.
 *   - LEFT (after the mac traffic-light gutter / before the win+linux window
 *     buttons): a workspace chip — accent swatch + name + chevron — that opens
 *     the switcher menu (see `WorkspaceMenu.vue`).
 *   - CENTER: a "⌘K  Search…" pill that focuses the app command palette. It is
 *     gated on a palette-ready handshake (`useCommandPalette().isMounted`), so it
 *     only shows on surfaces where a palette actually listens — never on
 *     /desktop/welcome, where it would dispatch into the void. It collapses to a
 *     bare icon on narrow windows so the drag region survives.
 *   - RIGHT: an unread pill (brand chip) fed by the badge composable, deep-linking
 *     to the Postbox Today view's "For you" section; on win/linux the custom
 *     minimize / maximize / close controls sit to its right.
 *
 * macOS: the native traffic lights sit over the left gutter (see
 * tauri.conf.json titleBarStyle/trafficLightPosition). Windows/Linux: the native
 * frame is removed in main.rs, so we render our own controls via the window.ts
 * bridge.
 *
 * The whole bar is a drag region (`data-tauri-drag-region`), and every
 * non-interactive wrapper carries it too (Tauri checks the exact mousedown
 * target). Interactive controls deliberately omit it so clicks land on them.
 */
import { formatBadgeCount } from '~/lib/desktop/workspaceTypes';
import DesktopWorkspaceMenu from './WorkspaceMenu.vue';

const { isDesktop, isMac } = useDesktopContext();
const { activeId, active } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();
const { isMounted: paletteMounted, open: openSearch } = useCommandPalette();
const { themePreference } = useAppTheme();

// Mirror the workspace identity + app theme into the native window: the window
// title feeds Mission Control / the App Switcher / the Dock's window list on
// macOS (where the in-frame title stays hidden — this bar is the visible one)
// and the taskbar / Alt-Tab on Windows/Linux; the theme pins the NSWindow
// appearance (traffic-light hovers, native menus) to the app's when it is
// forced away from the OS one. Reactive deps are read synchronously so the
// watcher re-fires; the bridge import stays lazy — a no-op outside Tauri.
watchEffect(() => {
	if (!isDesktop.value) return;
	const label = active.value?.label ?? null;
	const mac = isMac.value;
	const theme = themePreference.value;
	void (async () => {
		try {
			const mod = await import('@owlat/desktop/src/window');
			await mod.setWindowTitle(mod.windowTitleFor(label, mac));
			await mod.setWindowTheme(theme === 'system' ? null : theme);
		} catch {
			// Not running inside Tauri.
		}
	})();
});

const unreadCount = computed(() => {
	const id = activeId.value;
	return id ? badgeFor(id) : 0;
});
const unreadLabel = computed(() => formatBadgeCount(unreadCount.value));

async function control(fn: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow') {
	try {
		const mod = await import('@owlat/desktop/src/window');
		await mod[fn]();
	} catch {
		// Not running inside Tauri.
	}
}

// ── Unread pill → Postbox Today view, scrolled to "For you". Single navigation
// path: `@click.prevent` routes through `navigateTo` with the hash intact (the
// `to` attribute is kept for middle-click / copy-link). The Today view scrolls
// its own container to `#postbox-for-you` once that section mounts, so the deep
// link survives cold navigation where the section renders only after Convex data
// resolves — no fire-and-forget scroll from here.
function openForYou(): void {
	void navigateTo('/dashboard/postbox/inbox#postbox-for-you');
}
</script>

<template>
	<div
		v-if="isDesktop"
		data-tauri-drag-region
		class="desktop-titlebar fixed top-0 inset-x-0 z-[70] flex items-center h-[var(--titlebar-h,38px)] border-b border-border-subtle bg-bg-elevated select-none"
		:class="isMac ? 'pl-[88px] pr-2' : 'pl-2'"
	>
		<!-- LEFT — workspace chip / switcher (draggable gaps around it). -->
		<div class="relative flex items-center min-w-0" data-tauri-drag-region>
			<DesktopWorkspaceMenu v-if="active" />

			<!-- Fallback label when no workspace is connected yet. -->
			<div v-else class="flex items-center gap-2 pl-1" data-tauri-drag-region>
				<img src="/owlat.svg" alt="" class="w-4 h-4 shrink-0" data-tauri-drag-region />
				<span
					class="font-display text-[13px] leading-none text-text-secondary truncate"
					data-tauri-drag-region
				>
					Owlat
				</span>
			</div>
		</div>

		<!-- CENTER — search pill (absolutely centered so side padding never skews it).
		     Gated on a mounted command palette, so it never renders on surfaces
		     (e.g. /desktop/welcome) where its event would go nowhere. -->
		<button
			v-if="active && paletteMounted"
			type="button"
			class="tb-search absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2"
			aria-label="Search"
			@click="openSearch"
		>
			<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0" />
			<span class="hidden min-[560px]:inline text-[13px] leading-none">Search…</span>
			<kbd
				class="hidden min-[560px]:inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] font-medium text-text-tertiary bg-bg-elevated border border-border-subtle rounded"
			>
				<span class="text-xs">⌘</span>K
			</kbd>
		</button>

		<!-- RIGHT — unread pill + (win/linux) window controls. -->
		<div class="ml-auto flex items-stretch self-stretch" data-tauri-drag-region>
			<div class="flex items-center pr-1" data-tauri-drag-region>
				<NuxtLink
					v-if="unreadCount > 0"
					to="/dashboard/postbox/inbox#postbox-for-you"
					class="tb-unread text-white"
					:aria-label="`${unreadCount} awaiting you in Postbox`"
					:title="`${unreadCount} awaiting you`"
					@click.prevent="openForYou"
				>
					<Icon name="lucide:inbox" class="w-3.5 h-3.5" />
					<span class="tabular-nums text-[11px] font-[550] leading-none">{{ unreadLabel }}</span>
				</NuxtLink>
			</div>

			<!-- Windows/Linux window controls -->
			<div v-if="!isMac" class="flex items-stretch self-stretch">
				<button
					type="button"
					class="tb-btn"
					aria-label="Minimize"
					@click="control('minimizeWindow')"
				>
					<Icon name="lucide:minus" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="tb-btn"
					aria-label="Maximize"
					@click="control('toggleMaximizeWindow')"
				>
					<Icon name="lucide:square" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					class="tb-btn tb-close"
					aria-label="Close"
					@click="control('closeWindow')"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
/* Center search pill — bg-base + shadow-1, per the brief. */
.tb-search {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	height: 26px;
	max-width: 40vw;
	padding: 0 0.625rem;
	border-radius: 0.5rem;
	background-color: var(--color-bg-base);
	box-shadow: var(--shadow-1);
	color: var(--color-text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
.tb-search:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-primary);
}
.tb-search:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: 1px;
}

/* Right-side unread pill — the one place terracotta appears as a small chip.
   The white text comes from the `text-white` utility on the element. */
.tb-unread {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	height: 22px;
	padding: 0 0.5rem;
	border-radius: 999px;
	background-color: var(--color-brand);
	transition: filter var(--motion-fast) var(--ease-spring);
}
.tb-unread:hover {
	filter: brightness(1.05);
}
.tb-unread:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: 2px;
}

/* Windows/Linux caption controls. */
.tb-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 46px;
	height: 100%;
	color: var(--color-text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
.tb-btn:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-primary);
}
/* Warm terracotta close affordance — on-brand, not the generic Windows red. */
.tb-close:hover {
	background-color: var(--color-error);
	color: #fff;
}

@media (prefers-reduced-motion: reduce) {
	.tb-search,
	.tb-unread,
	.tb-btn {
		transition: none;
	}
}
</style>
