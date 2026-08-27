<script setup lang="ts">
/**
 * The thread-list pane's header — folder title, cold-start "updating…" hint,
 * mobile drawer handle, the newest/oldest sort toggle, and (inbox only) the
 * Today jump + Flat/Conversations/Categories segmented control. Extracted from
 * PostboxLayout.vue (the plan's R8 list-header seam): pure presentation over
 * semantic emits — every action routes back to the layout's existing handlers.
 */
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

const props = defineProps<{
	/** Resolved display name of the current folder (role label or custom name). */
	folderName: string;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	activeMessageId?: string | null;
	/** Cold start from the device cache — shows the quiet "updating…" shimmer. */
	showingCached?: boolean;
	isOffline?: boolean;
	/** Inbox-only view-mode control (Flat / Conversations / Categories). */
	viewMode?: string;
	viewModeOptions?: Array<{ value: string; label: string }>;
	/** Arrival direction of the list — 'newest' (default) or 'oldest'. */
	sortOrder?: string;
}>();

// One toggle, two states: the label names the order the list is IN, and the
// title names the order a tap moves TO, so the control is never ambiguous
// about which it is describing.
const sortIsOldest = computed(() => props.sortOrder === 'oldest');

const emit = defineEmits<{
	/** Mobile drawer handle pressed — the layout owns the drawer state. */
	'open-rail': [];
	/** Back to the focused Today landing view. */
	'switch-today': [];
	'select-view-mode': [value: string];
	/** Flip the arrival direction (newest <-> oldest). */
	'toggle-sort': [];
}>();
</script>

<template>
	<header class="border-b border-border-subtle px-4 py-3 flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 min-w-0">
			<!-- Drawer handle for the folder rail (mobile only). 44px square for
			     the thumb; the negative margins keep it from growing the header
			     past the height the 16px icon alone would give it. -->
			<button
				type="button"
				class="lg:hidden -ml-2 -my-2 w-11 h-11 flex items-center justify-center flex-shrink-0 rounded text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:aria-label="t('components.postbox.postboxLayout.openFolders')"
				@click="emit('open-rail')"
			>
				<Icon name="lucide:panel-left" class="w-4 h-4" />
			</button>
			<h2 class="text-sm font-semibold capitalize text-text-primary flex items-center gap-2 min-w-0">
				<span class="truncate">{{ folderName }}</span>
				<!-- Cold start from the device cache: a quiet "updating…" hint
				     while the live query catches up. Live rows replace in place.
				     Suppressed while offline: the live query never settles, so a
				     permanent "updating…" would read as stuck — the offline banner
				     already communicates the state. -->
				<span
					v-if="showingCached && !isOffline"
					class="animate-pulse text-[11px] font-normal text-text-tertiary lowercase"
					>{{ t('components.postbox.postboxLayout.updating') }}</span
				>
			</h2>
		</div>
		<div class="flex items-center gap-2">
			<!-- Arrival direction. Every folder gets it: "oldest first" is how a
			     backlog gets cleared, and it was previously unreachable. -->
			<button
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:title="
					sortIsOldest
						? t('components.postbox.postboxListHeader.sortToNewest')
						: t('components.postbox.postboxListHeader.sortToOldest')
				"
				:aria-label="
					sortIsOldest
						? t('components.postbox.postboxListHeader.sortToNewest')
						: t('components.postbox.postboxListHeader.sortToOldest')
				"
				@click="emit('toggle-sort')"
			>
				<Icon
					:name="sortIsOldest ? 'lucide:arrow-up-narrow-wide' : 'lucide:arrow-down-narrow-wide'"
					class="w-3.5 h-3.5"
					aria-hidden="true"
				/>
				<span class="hidden sm:inline">{{
					sortIsOldest
						? t('components.postbox.postboxListHeader.oldestFirst')
						: t('components.postbox.postboxListHeader.newestFirst')
				}}</span>
			</button>
			<template v-if="folderRole === 'inbox'">
				<!-- Back to the focused Today landing view (Esc / B do the same). -->
				<button
					v-if="!activeMessageId && !folderId"
					type="button"
					class="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-base focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
					aria-keyshortcuts="Escape b"
					:title="t('components.postbox.postboxLayout.backToTodayTitle')"
					@click="emit('switch-today')"
				>
					{{ t('common.today') }}
					<kbd
						class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
						aria-hidden="true"
						>{{ t('components.postbox.postboxLayout.escKey') }}</kbd
					>
				</button>
				<!-- Labeled view-mode control — exactly one mode active; persisted
				     per user. Inbox-only: other folders stay flat. -->
				<UiSegmentedControl
					v-if="viewModeOptions"
					size="sm"
					:aria-label="t('components.postbox.postboxLayout.inboxView')"
					:options="viewModeOptions"
					:model-value="viewMode"
					@update:model-value="emit('select-view-mode', String($event))"
				/>
			</template>
		</div>
	</header>
</template>
