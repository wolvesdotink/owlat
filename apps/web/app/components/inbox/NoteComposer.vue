<script setup lang="ts">
/**
 * Writes an internal note: a plain text box with @-mentions, posted with
 * Cmd/Ctrl+Enter or the button. Used for a new note (under the thread and in
 * Answer mode's Note tab) and for editing one in place.
 *
 * It must never be mistaken for the reply box, so it sits on the note tint
 * and says, above the text, that only the team sees it. Typing `@` opens the
 * teammate picker (`ChatMentionPicker`), which offers only people who can read
 * the Team Inbox; the server resolves the same handles, so whoever the picker
 * shows is whoever gets notified.
 *
 * Presentation only: the caller saves. `submit` hands over the text and waits
 * for the answer: the text stays until the save succeeds.
 */
import {
	NOTE_BODY_MAX_LENGTH,
	activeMentionQuery,
	insertMention,
	type NoteMentionCandidate,
} from '~/utils/threadNotes';
import { isImeComposing } from '~/utils/imeComposition';

const props = withDefaults(
	defineProps<{
		/** Save the note; resolves whether it was saved. */
		submit: (body: string) => Promise<boolean>;
		/** Teammates the picker offers for a typed fragment. */
		candidatesFor: (query: string) => NoteMentionCandidate[];
		/** Text to start from (editing an existing note). */
		initialBody?: string;
		/** Editing an existing note: the button says Save and Cancel shows. */
		editing?: boolean;
		/** Focus the box when it mounts. */
		autofocus?: boolean;
	}>(),
	{ initialBody: '', editing: false, autofocus: false }
);

const emit = defineEmits<{ (e: 'cancel'): void; (e: 'saved'): void }>();

const { t } = useI18n();

const body = ref(props.initialBody);
const textarea = ref<HTMLTextAreaElement | null>(null);
const saving = ref(false);
const mention = ref<{ start: number; fragment: string } | null>(null);

const candidates = computed(() =>
	mention.value ? props.candidatesFor(mention.value.fragment) : []
);
const remaining = computed(() => NOTE_BODY_MAX_LENGTH - body.value.length);
const canSave = computed(
	() =>
		body.value.trim().length > 0 &&
		remaining.value >= 0 &&
		!saving.value &&
		body.value.trim() !== (props.editing ? props.initialBody.trim() : '')
);

function fit() {
	const el = textarea.value;
	if (!el) return;
	el.style.height = 'auto';
	el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

function recalcMention() {
	const el = textarea.value;
	mention.value = el
		? activeMentionQuery(body.value, el.selectionStart ?? body.value.length)
		: null;
}

function onInput() {
	fit();
	recalcMention();
}

function pick(handle: string) {
	const el = textarea.value;
	const at = mention.value;
	if (!el || !at) return;
	const next = insertMention(body.value, at.start, el.selectionStart ?? body.value.length, handle);
	body.value = next.text;
	mention.value = null;
	void nextTick(() => {
		el.focus();
		el.setSelectionRange(next.caret, next.caret);
		fit();
	});
}

async function save() {
	if (!canSave.value) return;
	saving.value = true;
	try {
		if (await props.submit(body.value)) {
			if (!props.editing) body.value = '';
			mention.value = null;
			void nextTick(fit);
			emit('saved');
		}
	} finally {
		saving.value = false;
	}
}

function onKeydown(event: KeyboardEvent) {
	if (isImeComposing(event)) return;
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		void save();
		return;
	}
	if (event.key === 'Enter' && mention.value && candidates.value[0]?.handle) {
		// Enter takes the first teammate the picker shows, like Tab would.
		event.preventDefault();
		pick(candidates.value[0].handle);
		return;
	}
	if (event.key === 'Escape') {
		// The first Esc closes the picker; the next one leaves the box (and a
		// further one reaches the page, e.g. Answer mode's "leave").
		event.stopPropagation();
		if (mention.value) mention.value = null;
		else {
			textarea.value?.blur();
			emit('cancel');
		}
	}
}

onMounted(() => {
	fit();
	if (props.autofocus) textarea.value?.focus();
});

defineExpose({ focus: () => textarea.value?.focus() });
</script>

<template>
	<div
		class="relative rounded-(--radius-card) border border-warning/30 bg-warning/5 p-3"
		data-testid="note-composer"
	>
		<p class="mb-2 flex items-center gap-1.5 text-xs text-text-secondary">
			<Icon name="lucide:lock" class="size-3.5 shrink-0" aria-hidden="true" />
			{{ t('components.inbox.notes.privacyHint') }}
		</p>
		<ChatMentionPicker v-if="candidates.length > 0" :candidates="candidates" @pick="pick" />
		<textarea
			ref="textarea"
			v-model="body"
			rows="3"
			class="input w-full resize-none bg-bg-elevated text-sm"
			:placeholder="t('components.inbox.notes.placeholder')"
			:aria-label="
				editing ? t('components.inbox.notes.editLabel') : t('components.inbox.notes.composerLabel')
			"
			data-testid="note-composer-input"
			@input="onInput"
			@click="recalcMention"
			@keydown="onKeydown"
			@blur="mention = null"
		/>
		<div class="mt-2 flex flex-wrap items-center justify-between gap-2">
			<span
				class="text-xs tabular-nums"
				:class="remaining < 0 ? 'text-error' : 'text-text-tertiary'"
				data-testid="note-composer-hint"
			>
				<template v-if="remaining < 0">
					{{ t('components.inbox.notes.tooLong', { count: -remaining }, -remaining) }}
				</template>
				<template v-else-if="remaining < 200">
					{{ t('components.inbox.notes.remaining', { count: remaining }, remaining) }}
				</template>
				<template v-else>{{ t('components.inbox.notes.mentionHint') }}</template>
			</span>
			<span class="flex items-center gap-2">
				<UiButton v-if="editing" variant="ghost" size="sm" @click="emit('cancel')">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					size="sm"
					:disabled="!canSave"
					:loading="saving"
					data-testid="note-composer-save"
					@click="save"
				>
					<Icon v-if="!editing" name="lucide:sticky-note" class="size-3.5" />
					{{ editing ? t('components.inbox.notes.save') : t('components.inbox.notes.add') }}
				</UiButton>
			</span>
		</div>
	</div>
</template>
