<script setup lang="ts">
/**
 * Slack-style workspace rail for the desktop app. Renders one avatar per
 * connected owlat instance; clicking switches (reloads into that workspace),
 * "+" opens the connect screen. Desktop-only — the parent gates with `isDesktop`.
 *
 * The active workspace's avatar is filled with its identity accent (the same
 * colour that paints the window frame). Right-clicking (or the keyboard
 * context-menu key) any avatar opens an accent picker to recolour it.
 */
import { WORKSPACE_ACCENTS, type WorkspaceAccent, accentLabel } from '~/lib/desktop/workspaceTypes';
import { AVATAR_INK } from '~/utils/avatar';

const { workspaces, activeId, switchTo, setWorkspaceAccent } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();
// While ⌘ is held (Ctrl on Windows/Linux), reveal the ⌘1–9 switch hints on the
// first nine tiles so the (already-wired) useWorkspaceHotkeys shortcut is
// discoverable. Opacity-only, so no layout shift; the hint text stays in the DOM.
const { held: metaHeld } = useMetaHold();

/** Tile-face text colour — the warm off-white the avatar palette uses for
 * readable initials on a saturated accent fill (shared literal, see avatar.ts). */
const TILE_INK = AVATAR_INK;

/** Number hint for the Nth tile, or empty past the ⌘1–9 range. */
function hintFor(index: number): string {
	return index < 9 ? String(index + 1) : '';
}

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

// ---- accent picker popover ----
const pickerId = ref<string | null>(null);
const pickerPos = ref({ top: 0, left: 0 });
const pickerRef = ref<HTMLElement | null>(null);
// Trigger rect kept so the position can flip against the viewport once the
// popover has been measured (below the avatar by default; above / shifted-left
// when it would otherwise overflow — e.g. the last avatar in a tall list).
let triggerRect: DOMRect | null = null;
// Trigger element kept so keyboard focus returns to it on close (matching the
// house DropdownMenu pattern), instead of falling through to <body>.
let triggerEl: HTMLElement | null = null;

const pickerWs = computed(() => workspaces.value.find((w) => w.id === pickerId.value) ?? null);

function positionPicker(): void {
	const el = pickerRef.value;
	const rect = triggerRect;
	if (!el || !rect) return;
	const gap = 6;
	const { offsetWidth: w, offsetHeight: h } = el;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	// Vertical: below by default, flip above when it would clip the bottom.
	let top = rect.bottom + gap;
	if (top + h > vh && rect.top - gap - h >= 0) top = rect.top - gap - h;
	// Horizontal: align to the trigger, clamp within the viewport.
	const left = Math.max(gap, Math.min(rect.left, vw - w - gap));
	pickerPos.value = { top, left };
}

function openPicker(id: string, ev: MouseEvent): void {
	triggerEl = ev.currentTarget as HTMLElement;
	triggerRect = triggerEl.getBoundingClientRect();
	// Provisional position; refined once the popover is measured.
	pickerPos.value = { top: triggerRect.bottom + 6, left: triggerRect.left };
	pickerId.value = id;
	void nextTick(() => {
		positionPicker();
		swatchButtons()[0]?.focus();
	});
}

function closePicker(opts?: { restoreFocus?: boolean }): void {
	pickerId.value = null;
	triggerRect = null;
	// Return focus to the avatar that opened the picker (house DropdownMenu
	// parity) so a keyboard user is never left focused on <body> — but only on
	// the keyboard-dismiss paths (Escape / choosing a swatch). On an
	// outside-click the user is already interacting with another element
	// (search field, composer, control); yanking focus back to the avatar would
	// steal their click target, and a subsequent Enter would fire switchTo.
	if (opts?.restoreFocus !== false) triggerEl?.focus();
	triggerEl = null;
}

function chooseAccent(color: WorkspaceAccent): void {
	const id = pickerId.value;
	if (id) void setWorkspaceAccent(id, color);
	closePicker();
}

function swatchButtons(): HTMLButtonElement[] {
	return Array.from(pickerRef.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
}

function moveFocus(delta: number, to?: 'first' | 'last'): void {
	const buttons = swatchButtons();
	const len = buttons.length;
	if (!len) return;
	let next: number;
	if (to === 'first') {
		next = 0;
	} else if (to === 'last') {
		next = len - 1;
	} else {
		const found = buttons.findIndex((b) => b === document.activeElement);
		const current = found < 0 ? 0 : found;
		next = (current + delta + len) % len;
	}
	buttons[next]?.focus();
}

function onKeydown(e: KeyboardEvent): void {
	switch (e.key) {
		case 'Escape':
			closePicker();
			break;
		case 'ArrowRight':
		case 'ArrowDown':
			e.preventDefault();
			moveFocus(1);
			break;
		case 'ArrowLeft':
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
	if (pickerRef.value && !pickerRef.value.contains(e.target as Node))
		closePicker({ restoreFocus: false });
}

watch(pickerId, (id) => {
	if (id) {
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
	<div
		v-if="workspaces.length"
		class="flex items-center gap-2 overflow-x-auto px-3 py-2 border-b border-border-subtle"
	>
		<button
			v-for="(ws, i) in workspaces"
			:key="ws.id"
			:title="ws.label"
			:aria-current="ws.id === activeId ? 'true' : undefined"
			class="ws-tile relative h-9 w-9 flex-shrink-0 rounded-lg text-xs font-semibold grid place-items-center transition-transform duration-(--motion-fast) ease-spring focus-visible:outline-none"
			:class="ws.id === activeId ? 'ws-tile--active' : ''"
			:style="{
				backgroundColor: ws.accentColor,
				color: TILE_INK,
				'--ws-tile-accent': ws.accentColor,
			}"
			@click="switchTo(ws.id)"
			@contextmenu.prevent="openPicker(ws.id, $event)"
		>
			<!-- Initials + ⌘-hint share one grid cell; opacity-only crossfade keeps
			     zero layout shift and the hint text always in the DOM. -->
			<span
				class="col-start-1 row-start-1 transition-opacity duration-(--motion-fast) ease-spring"
				:class="metaHeld && i < 9 ? 'opacity-0' : 'opacity-100'"
			>
				{{ initials(ws.label) }}
			</span>
			<span
				aria-hidden="true"
				class="col-start-1 row-start-1 text-sm font-bold tabular-nums pointer-events-none transition-opacity duration-(--motion-fast) ease-spring"
				:class="metaHeld && i < 9 ? 'opacity-100' : 'opacity-0'"
			>
				{{ hintFor(i) }}
			</span>
			<DesktopWorkspaceUnreadBadge :count="badgeFor(ws.id)" class="absolute -top-1 -right-1" />
		</button>

		<NuxtLink
			to="/desktop/welcome"
			title="Add workspace"
			class="h-9 w-9 flex-shrink-0 rounded-lg bg-bg-base text-text-secondary hover:text-text-primary flex items-center justify-center"
		>
			<Icon name="lucide:plus" class="w-4 h-4" />
		</NuxtLink>

		<!-- Accent picker (right-click / context-menu key on an avatar). -->
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
					v-if="pickerId"
					ref="pickerRef"
					role="menu"
					aria-label="Workspace accent colour"
					class="fixed z-[80] flex items-center gap-1 rounded-lg border border-border-subtle bg-bg-elevated p-1.5 shadow-lg"
					:style="{ top: `${pickerPos.top}px`, left: `${pickerPos.left}px` }"
				>
					<button
						v-for="color in WORKSPACE_ACCENTS"
						:key="color"
						type="button"
						role="menuitemradio"
						:aria-checked="pickerWs?.accentColor === color"
						:aria-label="accentLabel(color)"
						:title="accentLabel(color)"
						class="grid h-8 w-8 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="chooseAccent(color)"
					>
						<span
							class="h-5 w-5 rounded-full transition-transform duration-(--motion-fast) ease-spring hover:scale-110"
							:class="
								pickerWs?.accentColor === color
									? 'ring-2 ring-text-primary ring-offset-2 ring-offset-bg-elevated'
									: ''
							"
							:style="{ backgroundColor: color }"
						/>
					</button>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>

<style scoped>
/* Active workspace: an accent ring with a base-coloured gap so it reads on any
 * tile hue. Uses the tile's own accent (set inline as --ws-tile-accent). */
.ws-tile--active {
	box-shadow:
		0 0 0 2px var(--color-bg-base),
		0 0 0 4px var(--ws-tile-accent);
}
.ws-tile:hover {
	transform: translateY(-1px);
}
/* Keyboard focus gets the brand ring, distinct from the identity accent ring. */
.ws-tile:focus-visible {
	box-shadow:
		0 0 0 2px var(--color-bg-base),
		0 0 0 4px var(--color-brand);
}
@media (prefers-reduced-motion: reduce) {
	.ws-tile,
	.ws-tile:hover {
		transform: none;
	}
}
</style>
