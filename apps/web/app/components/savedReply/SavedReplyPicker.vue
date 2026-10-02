<script setup lang="ts">
/**
 * The composer footer's saved-reply button and the picker it opens: a search
 * box over every reply the composer may insert, matched fuzzily against name
 * and shortcut, the most used first before anything is typed. ↑/↓ move, Enter
 * inserts, Esc closes. ⌘; / Ctrl+; opens it from the text (the composer binds
 * that and drives `open`).
 *
 * The footer of the dialog saves what is in the composer as a new reply and
 * links to where replies are managed.
 */
import { htmlToPlainText } from '@owlat/shared/html';
import type { EditorSnippet } from '~/composables/postbox/usePostboxSnippetPicker';
import { SAVED_REPLIES_CHORD } from '~/composables/useComposerSavedReplyPicker';
import { useChordKeys } from '~/composables/useChordKeys';
import { rankSnippets } from '~/utils/postboxSnippets';

const props = defineProps<{
	replies: EditorSnippet[];
	/** "Save as reply" needs text to save. */
	canSaveCurrent: boolean;
}>();

const open = defineModel<boolean>('open', { required: true });

const emit = defineEmits<{
	(e: 'pick', reply: EditorSnippet): void;
	(e: 'save-current'): void;
}>();

const { t } = useI18n();
const chordKeys = useChordKeys(SAVED_REPLIES_CHORD);

const query = ref('');
const active = ref(0);
const listId = useId();
const items = computed(() => rankSnippets(props.replies, query.value));

watch(open, (isOpen) => {
	if (!isOpen) return;
	query.value = '';
	active.value = 0;
});
watch(items, (next) => {
	active.value = Math.min(active.value, Math.max(0, next.length - 1));
});

function preview(reply: EditorSnippet): string {
	return htmlToPlainText(reply.bodyHtml).slice(0, 140);
}

function pick(reply: EditorSnippet | undefined) {
	if (reply) emit('pick', reply);
}

function onKeydown(event: KeyboardEvent) {
	const count = items.value.length;
	if (event.key === 'ArrowDown' && count > 0) {
		event.preventDefault();
		active.value = (active.value + 1) % count;
	} else if (event.key === 'ArrowUp' && count > 0) {
		event.preventDefault();
		active.value = (active.value - 1 + count) % count;
	} else if (event.key === 'Enter') {
		event.preventDefault();
		pick(items.value[active.value]);
	}
}

function saveCurrent() {
	open.value = false;
	emit('save-current');
}
</script>

<template>
	<UiButton
		variant="ghost"
		type="button"
		class="shrink-0"
		:title="`${t('shared.savedReplies.picker.button')} (${chordKeys.join(' ')})`"
		:aria-label="t('shared.savedReplies.picker.button')"
		data-testid="saved-reply-button"
		@click="open = true"
	>
		<Icon name="lucide:message-square-quote" class="w-4 h-4" />
	</UiButton>
	<UiModal v-model:open="open" size="lg" :title="t('shared.savedReplies.picker.title')">
		<div class="space-y-3" data-testid="saved-reply-picker">
			<input
				v-model="query"
				type="search"
				class="input w-full"
				role="combobox"
				aria-autocomplete="list"
				:aria-expanded="items.length > 0"
				:aria-controls="listId"
				:aria-activedescendant="items[active] ? `${listId}-${active}` : undefined"
				:placeholder="t('shared.savedReplies.picker.search')"
				:aria-label="t('shared.savedReplies.picker.search')"
				autofocus
				@keydown="onKeydown"
			/>
			<p v-if="replies.length === 0" class="py-6 text-center text-sm text-text-secondary">
				{{ t('shared.savedReplies.picker.empty') }}
			</p>
			<p v-else-if="items.length === 0" class="py-6 text-center text-sm text-text-secondary">
				{{ t('shared.savedReplies.picker.noMatch') }}
			</p>
			<ul
				v-else
				:id="listId"
				role="listbox"
				:aria-label="t('shared.savedReplies.picker.title')"
				class="max-h-80 overflow-y-auto -mx-1"
			>
				<li
					v-for="(reply, i) in items"
					:id="`${listId}-${i}`"
					:key="reply._id"
					role="option"
					:aria-selected="i === active"
					class="cursor-pointer rounded-md px-3 py-2"
					:class="i === active ? 'bg-brand-subtle' : 'hover:bg-bg-surface'"
					@mousemove="active = i"
					@click="pick(reply)"
				>
					<div class="flex items-center gap-2">
						<span class="truncate text-sm font-medium text-text-primary">{{ reply.name }}</span>
						<span v-if="reply.shortcut" class="shrink-0 font-mono text-xs text-text-tertiary"
							>;{{ reply.shortcut }}</span
						>
						<UiBadge v-if="reply.isShared" size="sm" class="ml-auto shrink-0">
							{{ t('shared.savedReplies.sharedBadge') }}
						</UiBadge>
					</div>
					<p class="mt-0.5 line-clamp-2 text-xs text-text-tertiary">{{ preview(reply) }}</p>
				</li>
			</ul>
			<div
				class="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3"
			>
				<UiButton
					variant="ghost"
					type="button"
					:disabled="!canSaveCurrent"
					data-testid="saved-reply-save-current"
					@click="saveCurrent"
				>
					<Icon name="lucide:bookmark-plus" class="w-4 h-4 mr-1.5" />
					{{ t('shared.savedReplies.saveCurrent') }}
				</UiButton>
				<NuxtLink
					to="/dashboard/preferences/snippets"
					class="text-xs text-text-secondary hover:text-text-primary hover:underline"
					@click="open = false"
				>
					{{ t('shared.savedReplies.picker.manage') }}
				</NuxtLink>
			</div>
		</div>
	</UiModal>
</template>
