<script lang="ts">
/**
 * One entry in a {@link ContextMenu}. `run` fires when the user selects it —
 * point it at the SAME handler the row's visible controls (or the Cmd-K verb)
 * already call, so a menu item is a second entry point to one action, never a
 * re-implementation.
 */
export interface ContextMenuItem {
	/** Stable key for :key + tests. */
	id: string;
	label: string;
	/** Optional lucide icon name (e.g. `lucide:archive`). */
	icon?: string;
	/** Render in the danger colour (destructive verbs). */
	danger?: boolean;
	disabled?: boolean;
	/** Draw a divider above this item (group separator). */
	separatorBefore?: boolean;
	run: () => void;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useModalFocus } from '../../composables/useModalFocus';

/**
 * App-wide right-click / context-menu primitive.
 *
 * Renderless-ish: it renders its default slot verbatim (no wrapper box, so it
 * is safe inside `<ul>`, `<tbody>` or flex rows) and exposes two handlers the
 * consumer binds onto its OWN trigger element:
 *
 *   <UiContextMenu :items="items" v-slot="{ onContextmenu, onKeydown }">
 *     <li @contextmenu="onContextmenu" @keydown="onKeydown"> … </li>
 *   </UiContextMenu>
 *
 * Opens on `contextmenu` (mouse right-click AND the keyboard context-menu key,
 * which browsers deliver as a `contextmenu` event) and, for keyboards that emit
 * a plain keydown instead (the `ContextMenu` key / Shift+F10), on `onKeydown`.
 * The menu is teleported to `<body>`, positioned at the pointer (or, for the
 * keyboard, at the trigger's box), focus-trapped, arrow-navigable, Esc-closes
 * and restores focus to the opener — all via the shared {@link useModalFocus}.
 * Motion + colours come from FF tokens (both themes, reduced-motion aware).
 *
 * Degrades gracefully: with no (enabled) items it never opens, so the native
 * browser menu shows through instead of an empty popover.
 */
const props = defineProps<{ items: ContextMenuItem[] }>();

const open = ref(false);
const position = ref({ x: 0, y: 0 });
const menuRef = ref<HTMLElement | null>(null);

const hasEnabledItems = computed(() => props.items.some((item) => !item.disabled));

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

function close() {
	open.value = false;
}

// Trap Tab, handle Escape and restore focus to the opener when we close.
useModalFocus(menuRef, () => open.value, close);

function openAt(x: number, y: number) {
	if (!hasEnabledItems.value) return;
	position.value = { x, y };
	open.value = true;
	// Clamp within the viewport once the menu has a measured size.
	void nextTick(() => {
		const el = menuRef.value;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const margin = 8;
		let nextX = x;
		let nextY = y;
		if (nextX + rect.width > window.innerWidth - margin) {
			nextX = Math.max(margin, window.innerWidth - rect.width - margin);
		}
		if (nextY + rect.height > window.innerHeight - margin) {
			nextY = Math.max(margin, window.innerHeight - rect.height - margin);
		}
		position.value = { x: nextX, y: nextY };
	});
}

/** Right-click, or the keyboard menu key delivered as a `contextmenu` event. */
function onContextmenu(event: MouseEvent) {
	if (!hasEnabledItems.value) return; // let the native menu through
	event.preventDefault();
	// The keyboard menu key reports (0,0) in most engines — anchor to the
	// element's box instead of the top-left corner.
	if (event.clientX === 0 && event.clientY === 0) {
		const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
		openAt(rect ? rect.left + 12 : 0, rect ? rect.bottom - 4 : 0);
		return;
	}
	openAt(event.clientX, event.clientY);
}

/** Keyboards that emit a plain keydown for the menu key / Shift+F10. */
function onKeydown(event: KeyboardEvent) {
	const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
	if (!isMenuKey) return;
	if (!hasEnabledItems.value) return;
	event.preventDefault();
	const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
	openAt(rect ? rect.left + 12 : 0, rect ? rect.bottom - 4 : 0);
}

function select(item: ContextMenuItem) {
	if (item.disabled) return;
	close();
	item.run();
}

function focusItem(index: number) {
	const items = menuRef.value?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR);
	items?.[index]?.focus();
}

/** Arrow / Home / End navigation within the open menu. */
function onMenuKeydown(event: KeyboardEvent) {
	const items = Array.from(menuRef.value?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []);
	if (items.length === 0) return;
	const current = items.findIndex((el) => el === document.activeElement);

	if (event.key === 'ArrowDown') {
		event.preventDefault();
		focusItem(current < items.length - 1 ? current + 1 : 0);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		focusItem(current > 0 ? current - 1 : items.length - 1);
	} else if (event.key === 'Home') {
		event.preventDefault();
		focusItem(0);
	} else if (event.key === 'End') {
		event.preventDefault();
		focusItem(items.length - 1);
	}
}

function onWindowPointerdown(event: MouseEvent) {
	if (menuRef.value && !menuRef.value.contains(event.target as Node)) close();
}

watch(open, (isOpen) => {
	if (typeof window === 'undefined') return;
	if (isOpen) {
		// `contextmenu` also opens on right-click, so listen on that too.
		window.addEventListener('pointerdown', onWindowPointerdown, true);
		window.addEventListener('contextmenu', onWindowPointerdown, true);
		window.addEventListener('resize', close);
		window.addEventListener('scroll', close, true);
	} else {
		window.removeEventListener('pointerdown', onWindowPointerdown, true);
		window.removeEventListener('contextmenu', onWindowPointerdown, true);
		window.removeEventListener('resize', close);
		window.removeEventListener('scroll', close, true);
	}
});

onUnmounted(() => {
	if (typeof window === 'undefined') return;
	window.removeEventListener('pointerdown', onWindowPointerdown, true);
	window.removeEventListener('contextmenu', onWindowPointerdown, true);
	window.removeEventListener('resize', close);
	window.removeEventListener('scroll', close, true);
});
</script>

<template>
	<slot :on-contextmenu="onContextmenu" :on-keydown="onKeydown" :open="open" />

	<Teleport to="body">
		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0 scale-95"
			enter-to-class="opacity-100 scale-100"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100 scale-100"
			leave-to-class="opacity-0 scale-95"
		>
			<div
				v-if="open"
				ref="menuRef"
				role="menu"
				aria-orientation="vertical"
				class="fixed z-50 min-w-44 max-w-64 py-1 rounded-lg border border-border-subtle bg-bg-elevated shadow-lg origin-top-left focus:outline-none"
				:style="{ top: `${position.y}px`, left: `${position.x}px` }"
				@keydown="onMenuKeydown"
				@contextmenu.prevent
			>
				<template v-for="item in items" :key="item.id">
					<div v-if="item.separatorBefore" class="my-1 h-px bg-border-subtle" role="separator" />
					<button
						type="button"
						role="menuitem"
						:tabindex="item.disabled ? -1 : 0"
						:disabled="item.disabled"
						class="w-full px-3 py-2 text-left text-sm flex items-center gap-2 transition-colors duration-(--motion-fast)"
						:class="
							item.disabled
								? 'text-text-tertiary cursor-not-allowed opacity-50'
								: item.danger
									? 'text-error hover:bg-error/10 focus-visible:bg-error/10'
									: 'text-text-primary hover:bg-bg-surface focus-visible:bg-bg-surface'
						"
						@click="select(item)"
					>
						<Icon v-if="item.icon" :name="item.icon" class="w-4 h-4 shrink-0" />
						<span class="truncate">{{ item.label }}</span>
					</button>
				</template>
			</div>
		</Transition>
	</Teleport>
</template>
