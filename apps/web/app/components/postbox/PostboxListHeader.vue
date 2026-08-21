<script setup lang="ts">
/**
 * The thread-list pane's header — folder name, cold-start "updating…" hint,
 * the inbox-only Today/view-mode controls, and the triage filter chips.
 *
 * Extracted from PostboxLayout so the list pane's chrome lives in one place
 * (and the layout stays under the file-size ratchet). Pure presentational:
 * every control emits; the layout owns the state.
 *
 * Triage filter chips (All / Unread / Starred / Attachments) render on the
 * flat list only — the grouped renderers own their sections, and search/label
 * views have their own scoping.
 */
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import { POSTBOX_VIEW_MODE_OPTIONS } from '~/utils/postboxViewMode';
import type { PostboxTriageFilter } from '~/composables/postbox/usePostboxTriageFilters';

defineProps<{
	folderName: string;
	/** Cold start from the device cache: a quiet "updating…" hint. Suppressed
	 * while offline (the banner already communicates that state). */
	showingCached: boolean;
	isOffline: boolean;
	/** Inbox-only controls (Today button + view-mode segmented control). */
	showInboxControls: boolean;
	/** The Today button only makes sense from the plain inbox list (not while
	 * a deep-linked message is open or inside a custom folder). */
	showTodayButton: boolean;
	/** Filter chips render only where they apply (flat list folders). */
	showTriageFilters: boolean;
	filter: PostboxTriageFilter;
	counts: { all: number; unread: number; starred: number; attachments: number };
	viewMode?: PostboxViewMode;
}>();

const emit = defineEmits<{
	'open-drawer': [];
	'switch-today': [];
	'select-view-mode': [value: string];
	'select-filter': [value: PostboxTriageFilter];
}>();

const FILTER_CHIPS: Array<{ value: PostboxTriageFilter; label: string }> = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'starred', label: 'Starred' },
	{ value: 'attachments', label: 'Attachments' },
];

function chipCount(
	counts: { all: number; unread: number; starred: number; attachments: number },
	value: PostboxTriageFilter
): number {
	return counts[value];
}
</script>

<template>
	<div class="border-b border-border-subtle">
		<header class="px-4 py-3 flex items-center justify-between gap-2">
			<!-- Mobile-only folder menu: opens the folder-rail drawer in stack mode.
			     Hidden on lg+ where the rail is permanently visible. -->
			<button
				type="button"
				class="lg:hidden -ml-1 p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				aria-label="Open folders"
				@click="emit('open-drawer')"
			>
				<Icon name="lucide:menu" class="w-5 h-5" />
			</button>
			<h2 class="text-sm font-semibold capitalize text-text-primary flex items-center gap-2 min-w-0">
				<span class="truncate">{{ folderName }}</span>
				<span
					v-if="showingCached && !isOffline"
					class="animate-pulse text-[11px] font-normal text-text-tertiary lowercase"
					>updating…</span
				>
			</h2>
			<div v-if="showInboxControls" class="flex items-center gap-2">
				<!-- Back to the focused Today landing view (Esc / B do the same). -->
				<button
					v-if="showTodayButton"
					type="button"
					class="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					aria-keyshortcuts="Escape b"
					title="Back to Today (Esc)"
					@click="emit('switch-today')"
				>
					Today
					<kbd
						class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
						aria-hidden="true"
						>esc</kbd
					>
				</button>
				<!-- Labeled view-mode control — exactly one mode active; persisted
				     per user. Inbox-only: other folders stay flat. -->
				<UiSegmentedControl
					size="sm"
					aria-label="Inbox view"
					:options="POSTBOX_VIEW_MODE_OPTIONS"
					:model-value="viewMode"
					@update:model-value="emit('select-view-mode', $event)"
				/>
			</div>
		</header>
		<!-- Triage filter chips: one tap from "everything" to "what needs me".
		     Counts always reflect the unfiltered rows, so a chip never hides its
		     own badge. -->
		<div
			v-if="showTriageFilters"
			class="px-4 pb-2.5 -mt-0.5 flex items-center gap-1.5 overflow-x-auto"
			role="group"
			aria-label="Filter messages"
		>
			<button
				v-for="chip in FILTER_CHIPS"
				:key="chip.value"
				type="button"
				class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors duration-(--motion-fast) outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
				:class="
					filter === chip.value
						? 'bg-brand-subtle border-brand/25 text-brand font-medium'
						: 'border-border-default bg-bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong'
				"
				:aria-pressed="filter === chip.value"
				@click="emit('select-filter', chip.value)"
			>
				{{ chip.label }}
				<span
					class="text-2xs tabular-nums"
					:class="filter === chip.value ? 'text-brand' : 'text-text-tertiary'"
					>{{ chipCount(counts, chip.value) }}</span
				>
			</button>
		</div>
	</div>
</template>
