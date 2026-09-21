<script setup lang="ts">
/**
 * The thread-list pane's header — folder title, cold-start "updating…" hint,
 * mobile drawer handle, the page select-all checkbox, the inbox's Today|Browse
 * switch, and one "Display" menu.
 *
 * It used to carry four competing controls on a ~380px pane: a five-segment
 * view-mode control wide enough to need its own horizontal scroller, a sort
 * toggle, a one-way Today jump, and a whole-folder select-all row. Every one of
 * them was a persisted preference or a rare action, so the preferences moved
 * into the Display menu, the Today jump became a two-way switch, and the
 * select-all escape hatch moved into the bulk bar where the selection lives.
 *
 * Pure presentation over semantic emits: every action routes back to the
 * layout's existing handlers.
 */
import type { Id } from '@owlat/api/dataModel';
import type { PostboxDensity } from '~/utils/postboxDensity';
import type { PostboxInboxMode } from '~/utils/postboxInboxMode';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { headerSelectionState } from '~/utils/postboxRangeSelect';

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
	/** Inbox-only view-mode options (Flat / Conversations / Categories / …). */
	viewMode?: string;
	viewModeOptions?: Array<{ value: string; label: string }>;
	/** Arrival direction of the list — 'newest' (default) or 'oldest'. */
	sortOrder?: string;
	/** List/reader row density, shown as a radio group in the Display menu. */
	density?: PostboxDensity;
	/** Where the reader sits (right / bottom / off). */
	readingPane?: PostboxReadingPane;
	/** Which inbox landing surface is on screen — drives the Today|Browse switch. */
	inboxMode?: PostboxInboxMode;
	/** Set on the flat list, which is the only renderer with a selection model. */
	mailboxId?: Id<'mailboxes'>;
	/** Ids of the rows the list currently has loaded, in render order. */
	pageIds?: string[];
}>();

// --- Select-all -------------------------------------------------------------
// The header owns the checkbox that covers the whole page of rows. The escape
// hatch past it ("and the rest of the folder") lives in the bulk bar, where the
// selection it grows is already rendered.
const mailboxIdRef = computed(() => props.mailboxId ?? null);
const bulk = usePostboxBulkActions(mailboxIdRef);
const pageIds = computed(() => props.pageIds ?? []);
const selectionEnabled = computed(() => props.mailboxId != null && pageIds.value.length > 0);
const selectionState = computed(() => headerSelectionState(pageIds.value, bulk.selected.value));

function toggleSelectPage() {
	if (selectionState.value === 'all') bulk.clear();
	else bulk.selectPage(pageIds.value as Id<'mailMessages'>[]);
}

/**
 * The Today|Browse switch is the inbox's landing-surface control, so it is
 * offered exactly where a landing surface exists: the inbox root, with no
 * message open and no custom folder standing in for it.
 */
const showInboxModeToggle = computed(
	() => props.folderRole === 'inbox' && !props.activeMessageId && !props.folderId
);

const emit = defineEmits<{
	/** Mobile drawer handle pressed — the layout owns the drawer state. */
	'open-rail': [];
	/** Today ↔ Browse (the same move B / Esc make). */
	'switch-inbox-mode': [value: PostboxInboxMode];
	'select-view-mode': [value: string];
	'select-sort-order': [value: PostboxSortOrder];
	'select-density': [value: PostboxDensity];
	'select-reading-pane': [value: PostboxReadingPane];
}>();
</script>

<template>
	<!-- Wraps rather than truncates. The list pane is ~380px at a 1440px window,
	     which the folder title plus the control cluster can still overflow in a
	     long locale: as one nowrap row the title lost first and read "In…" for
	     Inbox. Wrapping drops the cluster onto a second line only when it
	     genuinely does not fit, and a wide pane still gets the single row. -->
	<header
		class="border-b border-border-subtle px-4 py-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5"
	>
		<div class="flex items-center gap-2 min-w-0">
			<!-- Tri-state select-all over the rows that are loaded: unchecked,
			     a dash while some are picked, checked when the page is covered. -->
			<button
				v-if="selectionEnabled"
				type="button"
				role="checkbox"
				:aria-checked="
					selectionState === 'all' ? 'true' : selectionState === 'partial' ? 'mixed' : 'false'
				"
				class="w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center focus-visible:ring-1 focus-visible:ring-brand/40 outline-none"
				:class="
					selectionState === 'none'
						? 'border-border-subtle bg-bg-base'
						: 'bg-brand border-brand text-text-inverse'
				"
				:aria-label="
					selectionState === 'all'
						? t('components.postbox.postboxListHeader.deselectPage')
						: t('components.postbox.postboxListHeader.selectPage')
				"
				:title="
					selectionState === 'all'
						? t('components.postbox.postboxListHeader.deselectPage')
						: t('components.postbox.postboxListHeader.selectPage')
				"
				@click="toggleSelectPage()"
			>
				<Icon
					v-if="selectionState !== 'none'"
					:name="selectionState === 'all' ? 'lucide:check' : 'lucide:minus'"
					class="w-3 h-3"
				/>
			</button>
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
			<h2
				class="text-sm font-semibold capitalize text-text-primary flex items-center gap-2 min-w-0"
			>
				<span class="truncate">{{ folderName }}</span>
				<!-- Cold start from the device cache: a quiet "updating…" hint
				     while the live query catches up. Live rows replace in place.
				     Suppressed while offline: the live query never settles, so a
				     permanent "updating…" would read as stuck — the offline banner
				     already communicates the state. -->
				<span
					v-if="showingCached && !isOffline"
					class="animate-pulse motion-reduce:animate-none text-[11px] font-normal text-text-tertiary lowercase"
					>{{ t('components.postbox.postboxLayout.updating') }}</span
				>
			</h2>
			<!-- The inbox's landing-surface switch, on the title it describes. -->
			<PostboxInboxModeToggle
				v-if="showInboxModeToggle"
				class="flex-shrink-0"
				:mode="inboxMode ?? 'browse'"
				@select="emit('switch-inbox-mode', $event)"
			/>
		</div>
		<!-- Everything that used to be permanent chrome: four persisted
		     preferences behind one menu, so the pane never has to scroll a
		     control sideways to reach its own labels. The view-mode group is
		     withheld outside the inbox, where every folder renders flat and the
		     choice would be a control that does nothing. -->
		<PostboxListDisplayMenu
			:view-mode="viewMode"
			:view-mode-options="folderRole === 'inbox' ? viewModeOptions : undefined"
			:sort-order="sortOrder"
			:density="density"
			:reading-pane="readingPane"
			@select-view-mode="emit('select-view-mode', $event)"
			@select-sort-order="emit('select-sort-order', $event)"
			@select-density="emit('select-density', $event)"
			@select-reading-pane="emit('select-reading-pane', $event)"
		/>
	</header>
</template>
