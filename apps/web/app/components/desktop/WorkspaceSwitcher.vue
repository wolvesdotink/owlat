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
import { WORKSPACE_ACCENTS } from '~/lib/desktop/workspaceTypes';

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

const ACCENT_LABELS: Record<string, string> = {
	'#7a8c5a': 'Moss',
	'#c4785a': 'Terracotta',
	'#5a7a9b': 'Slate',
	'#8c5a7a': 'Plum',
	'#b8935a': 'Gold',
	'#3d3d3d': 'Graphite',
};

function accentLabel(color: string): string {
	return ACCENT_LABELS[color] ?? 'Accent';
}

// ---- accent picker popover ----
const pickerId = ref<string | null>(null);
const pickerPos = ref({ top: 0, left: 0 });
const pickerRef = ref<HTMLElement | null>(null);

const pickerWs = computed(() => workspaces.value.find((w) => w.id === pickerId.value) ?? null);

function openPicker(id: string, ev: MouseEvent): void {
	const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
	pickerPos.value = { top: rect.bottom + 6, left: rect.left };
	pickerId.value = id;
	void nextTick(() => pickerRef.value?.querySelector<HTMLElement>('button')?.focus());
}

function closePicker(): void {
	pickerId.value = null;
}

function chooseAccent(color: string): void {
	const id = pickerId.value;
	if (id) void setWorkspaceAccent(id, color);
	closePicker();
}

function onKeydown(e: KeyboardEvent): void {
	if (e.key === 'Escape') closePicker();
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
				enter-active-class="duration-(--motion-fast) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-fast-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="pickerId"
					ref="pickerRef"
					role="menu"
					aria-label="Workspace accent colour"
					class="fixed z-[80] flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-elevated p-2 shadow-lg"
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
						class="h-5 w-5 rounded-full transition-transform duration-(--motion-fast) hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="pickerWs?.accentColor === color ? 'ring-2 ring-text-primary' : ''"
						:style="{ backgroundColor: color }"
						@click="chooseAccent(color)"
					/>
				</div>
			</Transition>
		</Teleport>
	</div>
</template>
