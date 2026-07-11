<script setup lang="ts">
/**
 * Native-feel window titlebar for the desktop app. Renders nothing on web.
 *
 * The bar earns its 44px (`--titlebar-h`): it carries the chrome the page
 * used to duplicate.
 *   - LEFT (after the mac traffic-light gutter / before the win+linux window
 *     buttons): a workspace chip — accent swatch + name + chevron — that opens
 *     the switcher menu (see `WorkspaceMenu.vue`).
 *   - CENTER: a "⌘K  Search…" pill that focuses the app command palette. Gated
 *     on the `show-search` prop: the mounting surface knows whether a palette
 *     exists (the dashboard layout mounts one unconditionally and passes the
 *     prop; /desktop/welcome has none and omits it), so the pill can never
 *     dispatch into the void. It collapses to a bare icon on narrow windows so
 *     the drag region survives.
 *   - RIGHT: the Postbox notifications affordance — always present while a
 *     workspace is active (quiet inbox icon at zero; brand count pill when
 *     something awaits), deep-linking to the Postbox Today view's "For you"
 *     section. On win/linux the custom minimize / maximize / close controls sit
 *     to its right.
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

/** `showSearch`: the mounting surface has a command palette listening. */
const props = defineProps<{ showSearch?: boolean }>();

const { isDesktop, isMac } = useDesktopContext();
const { activeId, active } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();
const { open: openSearch } = useCommandPalette();
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
		class="desktop-titlebar fixed top-0 inset-x-0 z-(--z-titlebar) flex items-center h-[var(--titlebar-h,44px)] border-b border-border-subtle bg-bg-elevated select-none"
		:class="isMac ? 'pl-[88px] pr-2.5' : 'pl-2.5'"
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
		     Gated on the surface's `show-search` prop, so it never renders where
		     (e.g. /desktop/welcome) its event would go nowhere. -->
		<button
			v-if="active && props.showSearch"
			type="button"
			class="tb-search absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2"
			aria-label="Search"
			@click="openSearch"
		>
			<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0" />
			<span class="hidden min-[560px]:inline text-[13px] leading-none truncate">Search…</span>
			<kbd class="tb-kbd hidden min-[560px]:inline-flex">⌘K</kbd>
		</button>

		<!-- RIGHT — notifications affordance + (win/linux) window controls. Always
		     present while a workspace is active: a quiet inbox icon when nothing
		     awaits, the brand count pill when something does. -->
		<div class="ml-auto flex items-stretch self-stretch" data-tauri-drag-region>
			<div class="flex items-center pr-1" data-tauri-drag-region>
				<NuxtLink
					v-if="active"
					to="/dashboard/postbox/inbox#postbox-for-you"
					class="tb-unread"
					:class="unreadCount > 0 ? 'text-white' : 'tb-unread-idle'"
					:aria-label="
						unreadCount > 0 ? `${unreadCount} awaiting you in Postbox` : 'Open Postbox inbox'
					"
					:title="unreadCount > 0 ? `${unreadCount} awaiting you` : 'Postbox'"
					@click.prevent="openForYou"
				>
					<Icon name="lucide:inbox" class="w-3.5 h-3.5" />
					<span v-if="unreadCount > 0" class="tabular-nums text-[11px] font-[550] leading-none">{{
						unreadLabel
					}}</span>
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
/* Center search pill — reads as the palette's input field: recessed base
   surface, hairline border, placeholder-toned label, right-aligned shortcut.
   A steady clamp() width (wide windows only) gives it field presence instead
   of hugging its text. */
.tb-search {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	height: 30px;
	max-width: 40vw;
	padding: 0 0.375rem 0 0.75rem;
	border-radius: 10px;
	background-color: var(--color-bg-base);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-1);
	color: var(--color-text-tertiary);
	transition:
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
@media (min-width: 560px) {
	.tb-search {
		width: clamp(220px, 26vw, 340px);
	}
}
.tb-search:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-secondary);
}
.tb-search:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: 1px;
}
/* ⌘K shortcut chip, pushed to the field's far edge. */
.tb-kbd {
	margin-left: auto;
	align-items: center;
	padding: 3px 5px;
	font-size: 10.5px;
	font-weight: 550;
	line-height: 1;
	color: var(--color-text-tertiary);
	background-color: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	border-radius: 6px;
}

/* Right-side unread pill — the one place terracotta appears as a small chip.
   The white text comes from the `text-white` utility on the element. */
.tb-unread {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 0.375rem;
	height: 26px;
	padding: 0 0.625rem;
	border-radius: 999px;
	background-color: var(--color-brand);
	transition:
		filter var(--motion-fast) var(--ease-spring),
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
.tb-unread:hover {
	filter: brightness(1.05);
}
.tb-unread:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: 2px;
}
/* Nothing awaiting — the same slot as a quiet square icon button: no fill,
   no count, until there is something to say. */
.tb-unread-idle {
	width: 30px;
	height: 30px;
	padding: 0;
	border-radius: 10px;
	background-color: transparent;
	color: var(--color-text-secondary);
}
.tb-unread-idle:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-primary);
	filter: none;
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
