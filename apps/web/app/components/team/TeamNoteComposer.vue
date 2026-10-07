<script setup lang="ts">
/**
 * The bottom of a team thread (plan §4.3): two explicit modes, "Internal
 * note" and "Reply to <name>". Switching is a deliberate choice that shows
 * who reads what, and each mode keeps its own unsent text.
 *
 *  - Internal note: plain text with `@` to mention a teammate and `#` to link
 *    the note to one of the thread's actions. Only the team sees it; it never
 *    goes into customer mail, a quoted reply, the interpretation or a prompt.
 *  - Reply: the customer's reply is written in Answer mode. What is typed here
 *    goes with it ("Continue in Answer mode").
 *
 * Sticky at the bottom of the page on a phone. Presentation and drafts only:
 * the host saves the note and opens Answer mode.
 */
import type { BriefItemView } from '../../../../api/convex/mail/interpret/briefShape';
import { isImeComposing } from '~/utils/imeComposition';
import {
	NOTE_BODY_MAX_LENGTH,
	activeMentionQuery,
	insertMention,
	type NoteMentionCandidate,
} from '~/utils/threadNotes';
import { activeItemQuery, matchItems, removeItemQuery } from '~/utils/teamStream';

export type TeamComposeMode = 'note' | 'reply';

const props = withDefaults(
	defineProps<{
		/** Keys the note draft (one per thread). */
		draftKey: string;
		/** "Ana Costa"; null when there is no one to reply to. */
		replyName: string | null;
		/** Internal notes are available (Team Inbox, or chat on for a shared mailbox). */
		notesEnabled?: boolean;
		/** Actions a note can link to with `#`. */
		items?: readonly BriefItemView[];
		candidatesFor?: (query: string) => NoteMentionCandidate[];
		/** Save the note; resolves whether it was saved. */
		submitNote: (body: string, threadItemId: string | null) => Promise<boolean>;
	}>(),
	{ notesEnabled: true, items: () => [], candidatesFor: () => [] }
);

const mode = defineModel<TeamComposeMode>('mode', { default: 'note' });
/** The reply's unsent text (the host keeps it, e.g. for Answer mode). */
const replyDraft = defineModel<string>('replyDraft', { default: '' });

const emit = defineEmits<{ reply: [text: string] }>();

const { t } = useI18n();

// One unsent note per thread for the session, kept across mode switches and navigation.
const noteDrafts = useState<Record<string, { body: string; itemId: string | null }>>(
	'team:note-drafts',
	() => ({})
);
const noteDraft = computed({
	get: () => noteDrafts.value[props.draftKey] ?? { body: '', itemId: null },
	set: (draft) => {
		const next = { ...noteDrafts.value };
		if (draft.body || draft.itemId) next[props.draftKey] = draft;
		else delete next[props.draftKey];
		noteDrafts.value = next;
	},
});
const noteBody = computed({
	get: () => noteDraft.value.body,
	set: (body: string) => (noteDraft.value = { ...noteDraft.value, body }),
});
const linkedItem = computed(
	() => props.items.find((item) => item.id === noteDraft.value.itemId) ?? null
);

const activeMode = computed<TeamComposeMode>(() => {
	if (!props.notesEnabled) return 'reply';
	if (!props.replyName) return 'note';
	return mode.value;
});

const textarea = ref<HTMLTextAreaElement | null>(null);
const saving = ref(false);
const mention = ref<{ start: number; fragment: string } | null>(null);
const itemQuery = ref<{ start: number; fragment: string } | null>(null);
const mentionCandidates = computed(() =>
	mention.value ? props.candidatesFor(mention.value.fragment) : []
);
const itemCandidates = computed(() =>
	itemQuery.value ? matchItems(props.items, itemQuery.value.fragment) : []
);
const remaining = computed(() => NOTE_BODY_MAX_LENGTH - noteBody.value.length);
const canPost = computed(
	() => noteBody.value.trim().length > 0 && remaining.value >= 0 && !saving.value
);

function recalc() {
	const el = textarea.value;
	if (!el || activeMode.value !== 'note') {
		mention.value = itemQuery.value = null;
		return;
	}
	const caret = el.selectionStart ?? noteBody.value.length;
	mention.value = activeMentionQuery(noteBody.value, caret);
	itemQuery.value = mention.value ? null : activeItemQuery(noteBody.value, caret);
}

function setCaret(caret: number) {
	void nextTick(() => {
		textarea.value?.focus();
		textarea.value?.setSelectionRange(caret, caret);
	});
}

function pickMention(handle: string) {
	const el = textarea.value;
	const at = mention.value;
	if (!el || !at) return;
	const next = insertMention(noteBody.value, at.start, el.selectionStart ?? 0, handle);
	noteBody.value = next.text;
	mention.value = null;
	setCaret(next.caret);
}

function pickItem(item: BriefItemView) {
	const el = textarea.value;
	const at = itemQuery.value;
	if (!el || !at) return;
	const next = removeItemQuery(noteBody.value, at.start, el.selectionStart ?? 0);
	noteDraft.value = { body: next.text, itemId: item.id };
	itemQuery.value = null;
	setCaret(next.caret);
}

async function post() {
	if (!canPost.value) return;
	saving.value = true;
	try {
		if (await props.submitNote(noteBody.value.trim(), noteDraft.value.itemId)) {
			noteDraft.value = { body: '', itemId: null };
			mention.value = itemQuery.value = null;
		}
	} finally {
		saving.value = false;
	}
}

function continueReply() {
	emit('reply', replyDraft.value);
}

function onKeydown(event: KeyboardEvent) {
	if (isImeComposing(event)) return;
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		if (activeMode.value === 'note') void post();
		else continueReply();
		return;
	}
	if (event.key === 'Enter' && mention.value && mentionCandidates.value[0]?.handle) {
		event.preventDefault();
		pickMention(mentionCandidates.value[0].handle);
		return;
	}
	if (event.key === 'Enter' && itemQuery.value && itemCandidates.value[0]) {
		event.preventDefault();
		pickItem(itemCandidates.value[0]);
		return;
	}
	if (event.key === 'Escape' && (mention.value || itemQuery.value)) {
		event.stopPropagation();
		mention.value = itemQuery.value = null;
	}
}

/** Put the cursor in the box, in the given mode (the `n` and `r` keys). */
function focus(next?: TeamComposeMode) {
	if (next) mode.value = next;
	void nextTick(() => textarea.value?.focus());
}
defineExpose({ focus });
</script>

<template>
	<div
		class="sticky bottom-0 z-10 -mx-4 border-t border-border-subtle bg-bg-base px-4 pb-4 pt-3 sm:static sm:mx-0 sm:rounded-(--radius-card) sm:border sm:bg-bg-elevated"
		data-testid="team-note-composer"
		:data-mode="activeMode"
	>
		<div class="mb-2 flex flex-wrap items-center gap-2">
			<div
				role="radiogroup"
				:aria-label="t('components.team.composer.modeLabel')"
				class="inline-flex rounded-md border border-border-subtle bg-bg-surface p-0.5 text-xs"
			>
				<button
					v-if="notesEnabled"
					type="button"
					role="radio"
					class="inline-flex items-center gap-1 rounded px-2.5 py-1"
					:class="
						activeMode === 'note'
							? 'bg-bg-elevated text-text-primary shadow-sm'
							: 'text-text-tertiary'
					"
					:aria-checked="activeMode === 'note'"
					data-testid="team-composer-mode-note"
					@click="focus('note')"
				>
					<Icon name="lucide:lock" class="size-3" aria-hidden="true" />
					{{ t('components.team.composer.note') }}
				</button>
				<button
					v-if="replyName"
					type="button"
					role="radio"
					class="inline-flex items-center gap-1 rounded px-2.5 py-1"
					:class="
						activeMode === 'reply'
							? 'bg-bg-elevated text-text-primary shadow-sm'
							: 'text-text-tertiary'
					"
					:aria-checked="activeMode === 'reply'"
					data-testid="team-composer-mode-reply"
					@click="focus('reply')"
				>
					<Icon name="lucide:reply" class="size-3" aria-hidden="true" />
					{{ t('components.team.composer.replyTo', { name: replyName }) }}
				</button>
			</div>
			<span v-if="activeMode === 'note'" class="ml-auto text-2xs text-text-tertiary">
				{{ t('components.team.composer.hint') }}
			</span>
		</div>

		<div class="relative">
			<ChatMentionPicker
				v-if="mentionCandidates.length > 0"
				:candidates="mentionCandidates"
				@pick="pickMention"
			/>
			<div
				v-else-if="itemCandidates.length > 0"
				class="absolute bottom-full left-4 right-4 z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-border-subtle bg-bg-elevated shadow-xl"
				role="listbox"
				data-testid="team-composer-item-picker"
			>
				<button
					v-for="item in itemCandidates"
					:key="item.id"
					type="button"
					role="option"
					class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface"
					@mousedown.prevent="pickItem(item)"
				>
					<Icon name="lucide:hash" class="size-3.5 shrink-0 text-text-tertiary" />
					<span class="truncate text-text-primary">{{ item.text }}</span>
				</button>
			</div>

			<p
				v-if="activeMode === 'note' && linkedItem"
				class="mb-1.5 flex items-center gap-1.5 text-xs text-text-secondary"
				data-testid="team-composer-linked-item"
			>
				{{ t('components.team.note.on') }}
				<span class="truncate rounded-full bg-brand-subtle px-2 py-px font-medium text-brand">{{
					linkedItem.text
				}}</span>
				<button
					type="button"
					class="rounded p-0.5 text-text-tertiary hover:text-text-primary"
					:aria-label="t('components.team.composer.unlink')"
					@click="noteDraft = { ...noteDraft, itemId: null }"
				>
					<Icon name="lucide:x" class="size-3" />
				</button>
			</p>

			<textarea
				v-if="activeMode === 'note'"
				ref="textarea"
				v-model="noteBody"
				rows="2"
				class="input w-full resize-none border-warning/30 bg-warning/5 text-sm"
				:placeholder="
					replyName
						? t('components.team.composer.notePlaceholder', { name: replyName })
						: t('components.team.composer.notePlaceholderNoName')
				"
				:aria-label="t('components.team.composer.note')"
				data-testid="team-composer-note-input"
				@input="recalc"
				@click="recalc"
				@keydown="onKeydown"
				@blur="mention = itemQuery = null"
			/>
			<textarea
				v-else
				ref="textarea"
				v-model="replyDraft"
				rows="2"
				class="input w-full resize-none text-sm"
				:placeholder="t('components.team.composer.replyPlaceholder', { name: replyName ?? '' })"
				:aria-label="t('components.team.composer.replyTo', { name: replyName ?? '' })"
				data-testid="team-composer-reply-input"
				@keydown="onKeydown"
			/>
		</div>

		<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
			<span class="text-2xs text-text-tertiary">
				<template v-if="activeMode === 'note' && remaining < 0">
					{{ t('components.inbox.notes.tooLong', { count: -remaining }, -remaining) }}
				</template>
				<template v-else-if="activeMode === 'note'">{{
					t('components.team.composer.privacy', { name: replyName ?? '' })
				}}</template>
				<template v-else>{{ t('components.team.composer.replyHint') }}</template>
			</span>
			<UiButton
				v-if="activeMode === 'note'"
				size="sm"
				:disabled="!canPost"
				:loading="saving"
				data-testid="team-composer-post"
				@click="post"
			>
				<Icon name="lucide:lock" class="size-3.5" />
				{{ t('components.team.composer.post') }}
			</UiButton>
			<UiButton v-else size="sm" data-testid="team-composer-continue" @click="continueReply">
				<Icon name="lucide:reply" class="size-3.5" />
				{{ t('components.team.composer.continue') }}
			</UiButton>
		</div>
	</div>
</template>
