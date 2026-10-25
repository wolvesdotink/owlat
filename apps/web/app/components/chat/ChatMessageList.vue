<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { useReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import { useVirtualList } from '@owlat/ui/composables/useVirtualList';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

interface Props {
	messages: ChatMessageRow[];
	currentUserId: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	edit: [messageId: Id<'chatMessages'>, text: string];
	delete: [messageId: Id<'chatMessages'>];
}>();

const { t, locale } = useI18n();

const scrollerRef = ref<HTMLElement | null>(null);
const reducedMotion = useReducedMotion();

/** One row of the windowed list: a day separator or a message. */
type ChatListRow =
	| { kind: 'date'; key: string; label: string; firstInList: boolean }
	| { kind: 'message'; key: string; message: ChatMessageRow; firstInDay: boolean };

// Day separators and messages as one flat, keyed list, so the window can start
// or end inside a day and each separator is measured like any other row.
const rows = computed<ChatListRow[]>(() => {
	const dateFormat = new Intl.DateTimeFormat(locale.value, {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
	const out: ChatListRow[] = [];
	const seen = new Map<string, number>();
	let currentDate = '';
	for (const message of props.messages) {
		const messageDate = dateFormat.format(new Date(message.createdAt));
		const firstInDay = messageDate !== currentDate;
		if (firstInDay) {
			currentDate = messageDate;
			// Out-of-order timestamps can repeat a day; keys must stay unique.
			const repeat = seen.get(messageDate) ?? 0;
			seen.set(messageDate, repeat + 1);
			out.push({
				kind: 'date',
				key: repeat === 0 ? `date:${messageDate}` : `date:${messageDate}#${repeat}`,
				label: messageDate,
				firstInList: out.length === 0,
			});
		}
		out.push({ kind: 'message', key: message._id, message, firstInDay });
	}
	return out;
});

const isOwnMessage = (message: ChatMessageRow) => message.authorId === props.currentUserId;

/**
 * How close to the bottom (px) still counts as "reading the latest". Someone
 * scrolled up further than this is reading history, and a new message must not
 * yank them away from it.
 */
const STICK_TO_BOTTOM_PX = 80;

// Row heights before a row is measured, from the row's box: 8px of padding, a
// 20px name line, 22.75px per text line and a 2px gap above all but a day's
// first message. Close guesses keep the scrollbar steady while history mounts.
const MESSAGE_CHROME_PX = 28;
const TEXT_LINE_PX = 22.75;
const CHARS_PER_LINE = 100;
const ATTACHMENTS_PX = 48;
const estimates = new WeakMap<ChatMessageRow, number>();
const estimateRow = (row: ChatListRow): number => {
	if (row.kind === 'date') return row.firstInList ? 25 : 41;
	let estimate = estimates.get(row.message);
	if (estimate === undefined) {
		let lines = 0;
		for (const line of row.message.text.split('\n')) {
			lines += Math.max(1, Math.ceil(line.length / CHARS_PER_LINE));
		}
		estimate =
			MESSAGE_CHROME_PX +
			lines * TEXT_LINE_PX +
			((row.message.attachmentIds?.length ?? 0) > 0 ? ATTACHMENTS_PX : 0);
		estimates.set(row.message, estimate);
	}
	return estimate + (row.firstInDay ? 0 : 2);
};

// A message with its editor open keeps its draft in the row, so the row stays
// mounted while scrolled out of view.
const editingIds = shallowRef<ReadonlySet<string>>(new Set());
const onEditing = (messageId: Id<'chatMessages'>, active: boolean) => {
	const next = new Set(editingIds.value);
	if (active) next.add(messageId);
	else next.delete(messageId);
	editingIds.value = next;
};

// The message the composer's ↑ asked to edit. Mounted even when it is scrolled
// out of the window, so its row exists to open the editor in; the row takes
// the request while it renders, and the request ends with that render.
const requestedEditId = ref<Id<'chatMessages'> | null>(null);
const keepMountedIds = computed<ReadonlySet<string>>(() => {
	const id = requestedEditId.value;
	if (!id || editingIds.value.has(id)) return editingIds.value;
	return new Set([...editingIds.value, id]);
});

/** Open a message's inline editor and move focus into it (the composer's ↑). */
const openEditor = (messageId: Id<'chatMessages'>) => {
	requestedEditId.value = messageId;
	void nextTick(() => {
		if (requestedEditId.value === messageId) requestedEditId.value = null;
	});
};

defineExpose({ openEditor });

const {
	rows: visibleRows,
	paddingTop,
	paddingBottom,
	measure,
	distanceFromEnd,
	scrollToEnd,
} = useVirtualList({
	items: rows,
	getKey: (row) => row.key,
	estimateSize: estimateRow,
	scrollerRef,
	// Opening a room lands on the newest message at once; a reader at the
	// bottom stays there while a reply streams in or an attachment loads.
	stickToEnd: true,
	endThresholdPx: STICK_TO_BOTTOM_PX,
	keepMounted: () => keepMountedIds.value,
});

const rowClass = (row: ChatListRow): string => {
	if (row.kind === 'date') return row.firstInList ? 'pb-2' : 'pt-4 pb-2';
	return row.firstInDay ? '' : 'pt-0.5';
};

// A new message at the end follows the conversation only if the viewer was
// already at the bottom, or it is their own (they just sent it). This watcher
// runs before the DOM patch, so the distance is measured on the old content.
// Keyed on the last message id, not the length: older messages loaded above
// and edits are not new arrivals, and neither is the last message being
// deleted (the previous last id is then gone from the list).
watch(
	() => props.messages.at(-1)?._id,
	(lastId, previousLastId) => {
		if (!lastId || lastId === previousLastId) return;
		if (previousLastId && !props.messages.some((m) => m._id === previousLastId)) return;
		if (!scrollerRef.value) return;
		const wasNearBottom = distanceFromEnd() <= STICK_TO_BOTTOM_PX;
		const newest = props.messages.at(-1);
		if (!wasNearBottom && !(newest && isOwnMessage(newest))) return;
		const behavior: ScrollBehavior = reducedMotion.value ? 'auto' : 'smooth';
		nextTick(() => scrollToEnd(behavior));
	}
);
</script>

<template>
	<div ref="scrollerRef" class="flex-1 overflow-y-auto px-4 py-4">
		<div
			v-if="messages.length === 0"
			class="flex flex-col items-center justify-center h-full text-center py-12"
		>
			<div
				class="w-12 h-12 rounded-full bg-bg-surface border border-border-subtle flex items-center justify-center mb-4"
			>
				<Icon name="lucide:message-circle" class="w-6 h-6 text-text-tertiary" />
			</div>
			<p class="text-text-secondary font-medium">
				{{ t('components.chat.chatMessageList.emptyTitle') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('components.chat.chatMessageList.emptyBody') }}
			</p>
		</div>

		<!-- Only the rows near the viewport are mounted; the spacers stand in for
		     the rest of the history (see useVirtualList). -->
		<div v-else class="pb-4">
			<div :style="{ height: `${paddingTop}px` }" />
			<div
				v-for="row in visibleRows"
				:key="row.key"
				:ref="measure(row.key)"
				:data-row-kind="row.item.kind"
				:class="rowClass(row.item)"
				:style="row.gapBefore > 0 ? { marginTop: `${row.gapBefore}px` } : undefined"
			>
				<div v-if="row.item.kind === 'date'" class="flex items-center gap-4">
					<div class="flex-1 h-px bg-border-subtle" />
					<span class="text-[11px] text-text-tertiary font-medium flex-shrink-0">
						{{ row.item.label }}
					</span>
					<div class="flex-1 h-px bg-border-subtle" />
				</div>
				<ChatMessage
					v-else
					:message="row.item.message"
					:is-own-message="isOwnMessage(row.item.message)"
					:current-user-id="currentUserId"
					:edit-requested="row.item.message._id === requestedEditId"
					@edit="(id, text) => emit('edit', id, text)"
					@delete="(id) => emit('delete', id)"
					@editing="onEditing"
				/>
			</div>
			<div :style="{ height: `${paddingBottom}px` }" />
		</div>
	</div>
</template>
