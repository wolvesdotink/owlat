<script setup lang="ts">
/**
 * Native-feel window titlebar for the desktop app. Renders nothing on web.
 *
 * The bar earns its 38px: it carries the chrome the page used to duplicate.
 *   - LEFT (after the mac traffic-light gutter / before the win+linux window
 *     buttons): a workspace chip — accent swatch + name + chevron — that opens
 *     a lightweight workspace switcher menu.
 *   - CENTER: a "⌘K  Search…" pill that focuses the app command palette (via the
 *     same `owlat:command-palette-open` event the header search dispatched);
 *     it collapses to a bare icon on narrow windows so the drag region survives.
 *   - RIGHT: an unread pill (brand chip) fed by the badge composable, deep-linking
 *     to the Postbox Today view's "For you" section; on win/linux the custom
 *     minimize / maximize / close controls sit to its right.
 *
 * macOS: the native traffic lights sit over the left gutter (see
 * tauri.conf.json titleBarStyle/trafficLightPosition). Windows/Linux: the native
 * frame is removed in main.rs, so we render our own controls via the window.ts
 * bridge.
 *
 * The whole bar is a drag region (`data-tauri-drag-region`); every interactive
 * control deliberately omits the attribute so clicks land on it instead of
 * starting a window drag.
 */
import { WORKSPACE_ACCENTS, type WorkspaceAccent, accentLabel } from '~/lib/desktop/workspaceTypes';

const { isDesktop, isMac } = useDesktopContext();
const { workspaces, activeId, active, switchTo, setWorkspaceAccent } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();

const workspaceName = computed(() => active.value?.label ?? 'Owlat');
const workspaceAccent = computed(() => active.value?.accentColor ?? null);

const unreadCount = computed(() => {
	const id = activeId.value;
	return id ? badgeFor(id) : 0;
});
const unreadLabel = computed(() => (unreadCount.value > 99 ? '99+' : String(unreadCount.value)));

async function control(fn: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow') {
	try {
		const mod = await import('@owlat/desktop/src/window');
		await mod[fn]();
	} catch {
		// Not running inside Tauri.
	}
}

// ── Center search pill → focus the app command palette (c7). Falls back to the
// same event the Postbox palette listens for, so it works whichever palette is
// mounted on the current surface.
function openSearch(): void {
	if (import.meta.client) {
		window.dispatchEvent(new Event('owlat:command-palette-open'));
	}
}

// ── Unread pill → Postbox Today view, scrolled to "For you". Router hash nav is
// window-scoped and misses the Today view's own scroll container, so refine the
// scroll after the destination mounts (mirrors PostboxDailyBrief.scrollToAnchor).
async function openForYou(): Promise<void> {
	await navigateTo('/dashboard/postbox/inbox');
	if (!import.meta.client) return;
	await nextTick();
	requestAnimationFrame(() => {
		const el = document.querySelector('#postbox-for-you');
		if (!el) return;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
	});
}

// ── Workspace switcher menu ────────────────────────────────────────────────
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const chipRef = ref<HTMLElement | null>(null);
// The workspace whose accent picker is expanded inline within the menu.
const recoloring = ref<string | null>(null);

function initials(label: string): string {
	return label
		.replace(/^https?:\/\//, '')
		.split(/[\s.]+/)
		.map((p) => p[0])
		.filter(Boolean)
		.join('')
		.toUpperCase()
		.slice(0, 2);
}

function menuItems(): HTMLElement[] {
	return Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? []);
}

function openMenu(): void {
	menuOpen.value = true;
	void nextTick(() => menuItems()[0]?.focus());
}

function closeMenu(opts?: { restoreFocus?: boolean }): void {
	menuOpen.value = false;
	recoloring.value = null;
	if (opts?.restoreFocus !== false) chipRef.value?.focus();
}

function toggleMenu(): void {
	if (menuOpen.value) closeMenu();
	else openMenu();
}

function pickWorkspace(id: string): void {
	closeMenu({ restoreFocus: false });
	void switchTo(id);
}

function chooseAccent(id: string | null, color: WorkspaceAccent): void {
	if (!id) return;
	void setWorkspaceAccent(id, color);
	recoloring.value = null;
}

function moveMenuFocus(delta: number): void {
	const items = menuItems();
	if (!items.length) return;
	const found = items.findIndex((el) => el === document.activeElement);
	const next = (Math.max(0, found) + delta + items.length) % items.length;
	items[next]?.focus();
}

function onMenuKeydown(e: KeyboardEvent): void {
	switch (e.key) {
		case 'Escape':
			e.preventDefault();
			closeMenu();
			break;
		case 'ArrowDown':
			e.preventDefault();
			moveMenuFocus(1);
			break;
		case 'ArrowUp':
			e.preventDefault();
			moveMenuFocus(-1);
			break;
	}
}

function onClickOutside(e: MouseEvent): void {
	const target = e.target as Node;
	if (menuRef.value?.contains(target) || chipRef.value?.contains(target)) return;
	closeMenu({ restoreFocus: false });
}

watch(menuOpen, (open) => {
	if (!import.meta.client) return;
	if (open) {
		document.addEventListener('keydown', onMenuKeydown);
		document.addEventListener('click', onClickOutside, true);
	} else {
		document.removeEventListener('keydown', onMenuKeydown);
		document.removeEventListener('click', onClickOutside, true);
	}
});

onUnmounted(() => {
	if (!import.meta.client) return;
	document.removeEventListener('keydown', onMenuKeydown);
	document.removeEventListener('click', onClickOutside, true);
});
</script>

<template>
	<div
		v-if="isDesktop"
		data-tauri-drag-region
		class="desktop-titlebar fixed top-0 inset-x-0 z-[70] flex items-center h-[var(--titlebar-h,38px)] border-b border-border-subtle bg-bg-elevated select-none"
		:class="isMac ? 'pl-[88px] pr-2' : 'pl-2'"
	>
		<!-- LEFT — workspace chip / switcher trigger (draggable gaps around it). -->
		<div class="relative flex items-center min-w-0">
			<button
				v-if="active"
				ref="chipRef"
				type="button"
				class="tb-chip"
				aria-haspopup="menu"
				:aria-expanded="menuOpen"
				:title="workspaceName"
				@click="toggleMenu"
			>
				<span
					class="tb-swatch"
					:style="workspaceAccent ? { backgroundColor: workspaceAccent } : undefined"
				/>
				<span class="hidden min-[480px]:inline truncate max-w-[180px] text-[13px] leading-none">
					{{ workspaceName }}
				</span>
				<Icon name="lucide:chevron-down" class="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
			</button>

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

			<!-- Switcher menu -->
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="menuOpen"
					ref="menuRef"
					role="menu"
					aria-label="Switch workspace"
					class="absolute top-full left-0 mt-1 min-w-[240px] max-w-[320px] origin-top-left rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-lg z-[80]"
				>
					<button
						v-for="ws in workspaces"
						:key="ws.id"
						data-menu-item
						type="button"
						role="menuitemradio"
						:aria-checked="ws.id === activeId"
						class="tb-menu-item"
						@click="pickWorkspace(ws.id)"
						@contextmenu.prevent="recoloring = recoloring === ws.id ? null : ws.id"
					>
						<span
							class="tb-swatch"
							:style="ws.accentColor ? { backgroundColor: ws.accentColor } : undefined"
						>
							<span class="text-[9px] font-semibold text-white leading-none">{{
								initials(ws.label)
							}}</span>
						</span>
						<span
							class="flex-1 min-w-0 truncate text-left"
							:class="{ 'font-[550]': ws.id === activeId }"
						>
							{{ ws.label }}
						</span>
						<span
							v-if="badgeFor(ws.id) > 0"
							class="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-[10px] tabular-nums text-white inline-flex items-center justify-center"
						>
							{{ badgeFor(ws.id) > 99 ? '99+' : badgeFor(ws.id) }}
						</span>
						<Icon
							v-if="ws.id === activeId"
							name="lucide:check"
							class="w-3.5 h-3.5 shrink-0 text-brand"
						/>
					</button>

					<!-- Inline accent picker (right-click / context-menu key on a row). -->
					<div
						v-if="recoloring"
						class="flex items-center gap-1 px-2 py-1.5 mt-0.5 border-t border-border-subtle"
					>
						<button
							v-for="color in WORKSPACE_ACCENTS"
							:key="color"
							type="button"
							:aria-label="accentLabel(color)"
							:title="accentLabel(color)"
							class="grid h-6 w-6 place-items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
							@click="chooseAccent(recoloring, color)"
						>
							<span class="h-4 w-4 rounded-full" :style="{ backgroundColor: color }" />
						</button>
					</div>

					<div class="my-1 border-t border-border-subtle" />

					<NuxtLink
						to="/desktop/welcome"
						data-menu-item
						role="menuitem"
						class="tb-menu-item"
						@click="closeMenu({ restoreFocus: false })"
					>
						<span class="tb-swatch tb-swatch-add">
							<Icon name="lucide:plus" class="w-3.5 h-3.5 text-text-secondary" />
						</span>
						<span class="flex-1 text-left">Add workspace</span>
					</NuxtLink>
				</div>
			</Transition>
		</div>

		<!-- CENTER — search pill (absolutely centered so side padding never skews it).
		     Only meaningful once a workspace is active (the command palette mounts in
		     the dashboard layout); the welcome titlebar stays a plain brand strip. -->
		<button
			v-if="active"
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
		<div class="ml-auto flex items-stretch self-stretch">
			<div class="flex items-center pr-1">
				<NuxtLink
					v-if="unreadCount > 0"
					to="/dashboard/postbox/inbox#postbox-for-you"
					class="tb-unread"
					:aria-label="`${unreadCount} awaiting you in Postbox`"
					:title="`${unreadCount} awaiting you`"
					@click="openForYou"
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
/* Workspace chip. */
.tb-chip {
	display: inline-flex;
	align-items: center;
	gap: 0.5rem;
	min-width: 0;
	height: 26px;
	padding: 0 0.5rem;
	border-radius: 0.5rem;
	color: var(--color-text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
.tb-chip:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-primary);
}
.tb-chip:focus-visible {
	outline: 2px solid var(--color-brand);
	outline-offset: 1px;
}

.tb-swatch {
	display: inline-grid;
	place-items: center;
	width: 18px;
	height: 18px;
	flex-shrink: 0;
	border-radius: 0.375rem;
	background-color: var(--color-brand);
}
.tb-swatch-add {
	background-color: var(--color-bg-base);
	border: 1px solid var(--color-border-subtle);
}

/* Menu rows. */
.tb-menu-item {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	width: 100%;
	padding: 0.375rem 0.5rem;
	border-radius: 0.375rem;
	font-size: 13px;
	color: var(--color-text-primary);
	transition: background-color var(--motion-fast) var(--ease-spring);
}
.tb-menu-item:hover {
	background-color: var(--color-bg-surface-hover);
}
.tb-menu-item:focus-visible {
	outline: none;
	background-color: var(--color-bg-surface-hover);
	box-shadow: inset 0 0 0 2px var(--color-brand);
}

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

/* Right-side unread pill — the one place terracotta appears as a small chip. */
.tb-unread {
	display: inline-flex;
	align-items: center;
	gap: 0.3rem;
	height: 22px;
	padding: 0 0.5rem;
	border-radius: 999px;
	background-color: var(--color-brand);
	color: #fff;
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
	.tb-chip,
	.tb-search,
	.tb-menu-item,
	.tb-unread,
	.tb-btn {
		transition: none;
	}
}
</style>
