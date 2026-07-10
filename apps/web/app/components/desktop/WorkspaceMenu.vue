<script setup lang="ts">
/**
 * Workspace chip + switcher menu for the desktop titlebar. The chip shows the
 * active workspace's accent swatch, name and a chevron; clicking it opens a
 * lightweight menu to switch workspace, recolour its accent (right-click / the
 * context-menu key on a row) or add another. Split out of `DesktopTitlebar.vue`
 * so the bar stays under the file-size ratchet and this menu is the single home
 * for workspace switching on desktop (the old sidebar rail is retired).
 *
 * The chip and menu are interactive controls, so they deliberately omit
 * `data-tauri-drag-region` — clicks land on them instead of dragging the window.
 */
import {
	WORKSPACE_ACCENTS,
	type WorkspaceAccent,
	accentLabel,
	formatBadgeCount,
	initials,
} from '~/lib/desktop/workspaceTypes';

const { workspaces, activeId, active, switchTo, setWorkspaceAccent } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();

const workspaceName = computed(() => active.value?.label ?? 'Owlat');
const workspaceAccent = computed(() => active.value?.accentColor ?? null);

const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);
const chipRef = ref<HTMLElement | null>(null);
// The workspace whose accent picker is expanded inline within the menu.
const recoloring = ref<string | null>(null);

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

function focusMenuItem(index: number): void {
	const items = menuItems();
	if (!items.length) return;
	const clamped = ((index % items.length) + items.length) % items.length;
	items[clamped]?.focus();
}

function moveMenuFocus(delta: number): void {
	const items = menuItems();
	if (!items.length) return;
	const found = items.findIndex((el) => el === document.activeElement);
	focusMenuItem(Math.max(0, found) + delta);
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
		case 'Home':
			e.preventDefault();
			focusMenuItem(0);
			break;
		case 'End':
			e.preventDefault();
			focusMenuItem(-1);
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
	<div class="relative flex items-center min-w-0">
		<button
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
						<span class="text-[9px] font-[550] text-white leading-none">{{
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
						{{ formatBadgeCount(badgeFor(ws.id)) }}
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

@media (prefers-reduced-motion: reduce) {
	.tb-chip,
	.tb-menu-item {
		transition: none;
	}
}
</style>
