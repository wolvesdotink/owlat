<script setup lang="ts">
/**
 * Shared workspace-switcher menu for the desktop app.
 *
 * A compact dropdown alternative to the Slack-style rail: the active workspace's
 * accent dot + label acts as the trigger (used as the titlebar chip), and the
 * menu lists every connected workspace with its accent, unread badge and a check
 * on the active one — click to switch (through the same perceived-instant
 * switchTo choreography the rail uses). A footer links to the add-workspace flow.
 *
 * Keyboard: ArrowUp/Down + Home/End move between items, Escape closes and
 * restores focus to the trigger (never dropping to <body>) — mirroring the house
 * DropdownMenu / this desktop rail's accent picker (brief rule 8).
 *
 * Rendered only on desktop; the parent (titlebar) already gates with isDesktop.
 * The trigger deliberately omits `data-tauri-drag-region` so clicks open the
 * menu instead of starting a window drag.
 */
const { workspaces, activeId, active, switchTo } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

const title = computed(() => active.value?.label ?? 'Owlat');

/** Every focusable row in the menu, in DOM (visual) order. */
function menuItems(): HTMLElement[] {
	return Array.from(
		menuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]') ?? []
	);
}

function moveFocus(delta: number, to?: 'first' | 'last'): void {
	const items = menuItems();
	const len = items.length;
	if (!len) return;
	let next: number;
	if (to === 'first') next = 0;
	else if (to === 'last') next = len - 1;
	else {
		const found = items.findIndex((el) => el === document.activeElement);
		next = ((found < 0 ? 0 : found) + delta + len) % len;
	}
	items[next]?.focus();
}

function closeMenu(opts?: { restoreFocus?: boolean }): void {
	open.value = false;
	// Return focus to the chip on keyboard-dismiss paths (Escape / choosing) so a
	// keyboard user is never stranded on <body>; leave it alone on outside-click,
	// where the user is already interacting with another element.
	if (opts?.restoreFocus !== false) triggerRef.value?.focus();
}

function toggle(): void {
	if (open.value) {
		closeMenu();
		return;
	}
	open.value = true;
	void nextTick(() => menuItems()[0]?.focus());
}

function choose(id: string): void {
	closeMenu();
	if (id !== activeId.value) void switchTo(id);
}

function onKeydown(e: KeyboardEvent): void {
	switch (e.key) {
		case 'Escape':
			closeMenu();
			break;
		case 'ArrowDown':
			e.preventDefault();
			moveFocus(1);
			break;
		case 'ArrowUp':
			e.preventDefault();
			moveFocus(-1);
			break;
		case 'Home':
			e.preventDefault();
			moveFocus(0, 'first');
			break;
		case 'End':
			e.preventDefault();
			moveFocus(0, 'last');
			break;
	}
}

function onClickOutside(e: MouseEvent): void {
	if (rootRef.value && !rootRef.value.contains(e.target as Node))
		closeMenu({ restoreFocus: false });
}

watch(open, (isOpen) => {
	if (isOpen) {
		document.addEventListener('keydown', onKeydown);
		document.addEventListener('click', onClickOutside, true);
	} else {
		document.removeEventListener('keydown', onKeydown);
		document.removeEventListener('click', onClickOutside, true);
	}
});

onUnmounted(() => {
	document.removeEventListener('keydown', onKeydown);
	document.removeEventListener('click', onClickOutside, true);
});
</script>

<template>
	<div v-if="workspaces.length" ref="rootRef" class="relative flex items-center min-w-0">
		<button
			ref="triggerRef"
			type="button"
			class="flex items-center h-[30px] gap-2 min-w-0 rounded-[10px] px-2.5 -mx-1 hover:bg-bg-surface-hover transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
			:class="{ 'bg-bg-surface-hover': open }"
			aria-haspopup="menu"
			:aria-expanded="open"
			aria-label="Switch workspace"
			@click="toggle"
		>
			<span
				v-if="active"
				class="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-inset ring-black/10"
				:style="{ backgroundColor: active.accentColor }"
			/>
			<span class="font-display text-[13px] font-[550] leading-none truncate text-text-primary">
				{{ title }}
			</span>
			<Icon name="lucide:chevrons-up-down" class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
		</button>

		<Transition
			enter-active-class="duration-(--motion-moderate) ease-spring"
			enter-from-class="opacity-0 -translate-y-1"
			enter-to-class="opacity-100 translate-y-0"
			leave-active-class="duration-(--motion-moderate-exit) ease-exit"
			leave-from-class="opacity-100 translate-y-0"
			leave-to-class="opacity-0 -translate-y-1"
		>
			<div
				v-if="open"
				ref="menuRef"
				role="menu"
				aria-label="Workspaces"
				class="absolute top-full left-0 mt-1 z-[80] min-w-56 max-w-72 rounded-lg border border-border-subtle bg-bg-elevated p-1 shadow-lg"
			>
				<button
					v-for="ws in workspaces"
					:key="ws.id"
					type="button"
					role="menuitemradio"
					:aria-checked="ws.id === activeId"
					class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-bg-surface-hover transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					@click="choose(ws.id)"
				>
					<span
						class="h-2.5 w-2.5 rounded-full shrink-0"
						:style="{ backgroundColor: ws.accentColor }"
					/>
					<span
						class="flex-1 min-w-0 truncate text-sm"
						:class="ws.id === activeId ? 'font-semibold text-text-primary' : 'text-text-secondary'"
					>
						{{ ws.label }}
					</span>
					<DesktopWorkspaceUnreadBadge :count="badgeFor(ws.id)" />
					<Icon
						v-if="ws.id === activeId"
						name="lucide:check"
						class="w-3.5 h-3.5 text-brand shrink-0"
					/>
				</button>

				<div class="my-1 h-px bg-border-subtle" />

				<NuxtLink
					to="/desktop/welcome"
					role="menuitem"
					class="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-surface-hover hover:text-text-primary transition-colors duration-(--motion-fast) ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
					@click="closeMenu({ restoreFocus: false })"
				>
					<Icon name="lucide:plus" class="w-3.5 h-3.5 shrink-0" />
					Add workspace
				</NuxtLink>
			</div>
		</Transition>
	</div>
</template>
