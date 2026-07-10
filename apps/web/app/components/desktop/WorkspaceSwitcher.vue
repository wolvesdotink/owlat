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

const { workspaces, activeId, switchTo, setWorkspaceAccent } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();

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

function closePicker(): void {
	pickerId.value = null;
	triggerRect = null;
	// Return focus to the avatar that opened the picker (house DropdownMenu
	// parity) so a keyboard user is never left focused on <body>.
	triggerEl?.focus();
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
	if (pickerRef.value && !pickerRef.value.contains(e.target as Node)) closePicker();
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
			v-for="ws in workspaces"
			:key="ws.id"
			:title="ws.label"
			class="relative h-9 w-9 flex-shrink-0 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors"
			:class="
				ws.id === activeId ? 'text-white' : 'bg-bg-base text-text-secondary hover:text-text-primary'
			"
			:style="ws.id === activeId ? { backgroundColor: ws.accentColor } : undefined"
			@click="switchTo(ws.id)"
			@contextmenu.prevent="openPicker(ws.id, $event)"
		>
			{{ initials(ws.label) }}
			<span
				v-if="badgeFor(ws.id) > 0"
				class="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-[10px] text-white flex items-center justify-center"
			>
				{{ badgeFor(ws.id) > 99 ? '99+' : badgeFor(ws.id) }}
			</span>
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
