<script setup lang="ts">
/**
 * The Team inbox reply, in Answer mode's composer column (plan §07).
 *
 * One composer for every state a team message can be in:
 *
 *  - An agent draft opens in the editor, tagged as the agent's. Send sends it
 *    (unchanged, that is the one-click approve), "Discard draft" rejects it,
 *    "Write my own" clears the editor. What the person changed against the
 *    agent's original is under ⋯ ("Show changes").
 *  - No draft: an empty editor.
 *  - The agent is still drafting, or the message was already answered: the
 *    editor opens as usual and a notice says where the text goes (over the
 *    agent's unfinished draft, or out as a follow-up).
 *  - The message is in a state no reply can go to (still being read, filed as
 *    an update, the reply on its way): no editor, a plain reason instead.
 *  - A teammate is replying: Send is held, and its label says who ("Priya is
 *    replying"). Saving is not held.
 *
 * The envelope folds to one line ("To Ana · Re: Invoice"); the subject opens on
 * a click. Slots: `above-editor` (the agent's questions, Draft with AI; it
 * receives the reply as `composer`), `attachments` (the
 * files under the editor), `blocked-action` (what a blocked state offers).
 *
 * Saved replies go in from a `;` typed into the text, the footer's picker (⌘;)
 * or ⌘K (`useTeamComposerSavedReplies`); a reply's gaps hold Send.
 *
 * It answers a `teamThread` composer target (`utils/composerTarget`) inside the
 * Postbox composer's frame and footer, which read the target's capabilities:
 * plain text to the sender, the same pre-send checks, no paperclip, schedule,
 * reminder, signatures or send-as (files come through `attachments`).
 *
 * Presentation only: the page owns the mutations (`useTeamThreadComposer`) and
 * receives `send` (with whether the text differs from the agent draft, and the
 * subject), `save` and `reject`.
 */
import PostboxComposerFooter from '~/components/postbox/PostboxComposerFooter.vue';
import PostboxComposerShell from '~/components/postbox/PostboxComposerShell.vue';
import PostboxSnippetPicker from '~/components/postbox/PostboxSnippetPicker.vue';
import PostboxSnippetVariableDialog from '~/components/postbox/PostboxSnippetVariableDialog.vue';
import ThreadComposerMenu from './ThreadComposerMenu.vue';
import { composerPreflight, type TeamThreadComposerTarget } from '~/utils/composerTarget';
import { useTeamComposerAnswerApi } from '~/composables/useTeamComposerAnswerApi';
import { useTeamComposerGaps } from '~/composables/useTeamComposerGaps';
import {
	useTeamComposerSavedReplies,
	type SavedReplyRecipient,
} from '~/composables/useTeamComposerSavedReplies';
import { useChordKeys } from '~/composables/useChordKeys';
import {
	REPLY_BLOCKER_KEYS,
	REPLY_NOTICE_KEYS,
	type ReplyBlocker,
	type ReplyNotice,
} from '~/utils/teamThreadReply';

const props = withDefaults(
	defineProps<{
		/** The message the reply answers. */
		target: TeamThreadComposerTarget;
		/** Who a reply goes to ("To Ana Ruiz"). */
		senderLabel: string;
		/** Why nothing can be sent right now; `null` = the composer can send. */
		blocker?: ReplyBlocker | null;
		/** Where the text goes, when not the plain answer to a waiting message. */
		notice?: ReplyNotice | null;
		/** The working draft to pre-fill with (agent's or a saved edit). */
		draft?: string | null;
		/** The agent's original draft — the "before" of the edit diff. */
		originalDraft?: string | null;
		/** The reply's subject to pre-fill (the draft's, or "Re: …"). */
		subject?: string | null;
		busy?: boolean;
		/** A teammate is replying right now: sending is held, saving is not. */
		held?: boolean;
		/** Who is replying, for the held Send label. */
		heldBy?: string | null;
		/** The longer hold reason under the footer. */
		heldReason?: string;
		/** Something else holds Send (an attachment still copying), with the reason. */
		sendHold?: string | null;
		/** A quiet note beside Send ("2 of 3 asks covered"). */
		statusNote?: string;
		/** Draft with AI has a session on this thread: its `[[...]]` gaps hold Send. */
		askSession?: boolean;
		/** Who the reply goes to, for a saved reply's `{{contact.*}}` variables. */
		recipient?: SavedReplyRecipient | null;
	}>(),
	{
		blocker: null,
		notice: null,
		draft: null,
		originalDraft: null,
		subject: null,
		busy: false,
		held: false,
		heldBy: null,
		heldReason: undefined,
		sendHold: null,
		statusNote: undefined,
		askSession: false,
		recipient: null,
	}
);

const emit = defineEmits<{
	/** Send `body` under `subject`. `fromDraft` = unchanged agent draft (plain approve). */
	(e: 'send', body: string, fromDraft: boolean, subject: string): void;
	/** Keep the edit as the working draft without sending. */
	(e: 'save', body: string, subject: string): void;
	(e: 'reject'): void;
	/** The person is typing (or stopped) — drives the "is replying" presence. */
	(e: 'typing', active: boolean): void;
}>();

const { t } = useI18n();

const hasDraft = computed(() => !!props.draft?.trim());
const body = ref(props.draft ?? '');
const subject = ref(props.subject ?? '');
const textarea = ref<HTMLTextAreaElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const subjectOpen = ref(false);
const diffOpen = ref(false);

// A new draft arriving (the agent finished, a teammate saved) re-seeds the box
// unless the person has already started changing it.
const touched = ref(false);
watch(
	() => props.draft,
	(next) => {
		if (!touched.value) body.value = next ?? '';
	}
);
watch(
	() => props.subject,
	(next) => {
		if (!touched.value) subject.value = next ?? '';
	}
);

const subjectEdited = computed(() => subject.value.trim() !== (props.subject ?? '').trim());
const edited = computed(
	() => hasDraft.value && (body.value.trim() !== (props.draft ?? '').trim() || subjectEdited.value)
);
const diffBase = computed(() => props.originalDraft ?? props.draft ?? '');
const hasChanges = computed(
	() => hasDraft.value && body.value.trim() !== '' && body.value.trim() !== diffBase.value.trim()
);
// A `[TODO]` or `{{name}}` the agent (or the person) left in the reply.
const preflight = computed(() =>
	body.value.trim()
		? composerPreflight(props.target, { subject: subject.value, body: body.value })
		: []
);

const sendLabel = computed(() =>
	props.held && props.heldBy
		? t('components.inbox.inboxThreadPresence.titleReplying', { name: props.heldBy })
		: t('dashboard.inbox.detail.composer.send')
);

watch(
	[() => props.blocker, edited, () => body.value.trim().length > 0],
	([blocker, isEdited, hasText]) => {
		emit('typing', blocker === null && (isEdited || (!hasDraft.value && hasText)));
	},
	{ immediate: true }
);

function onInput(event: Event) {
	touched.value = true;
	body.value = (event.target as HTMLTextAreaElement).value;
	savedReplies.refreshTrigger();
}

function onSubjectInput(event: Event) {
	touched.value = true;
	subject.value = (event.target as HTMLInputElement).value;
}

// Now (iOS raises the keyboard only for a focus inside the tap), and again
// after the render for callers that have just made the textarea appear.
function focus() {
	textarea.value?.focus();
	void nextTick(() => textarea.value?.focus());
}

function send() {
	if (!canSend.value) return;
	emit('send', body.value, hasDraft.value && !edited.value, subject.value);
}

function writeOwn() {
	touched.value = true;
	body.value = '';
	savedReplies.gapGuarded.value = false;
	focus();
}

function restoreDraft() {
	touched.value = false;
	body.value = props.draft ?? '';
	subject.value = props.subject ?? '';
}

function onKeydown(event: KeyboardEvent) {
	if (savedReplies.handleKeydown(event)) return;
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		send();
	}
}

/** After a successful send the page clears the box. */
function reset() {
	touched.value = false;
	body.value = '';
	subject.value = props.subject ?? '';
	diffOpen.value = false;
	savedReplies.gapGuarded.value = false;
}

/** Reopen with text handed back to the person (an undone follow-up). */
function fill(text: string, nextSubject: string) {
	touched.value = true;
	body.value = text;
	subject.value = nextSubject;
	focus();
}

/** Put text into the editor, as a draft the person then edits (a file answer's note). */
function insert(text: string) {
	touched.value = true;
	body.value = body.value.trim() ? `${body.value.trimEnd()}\n\n${text}` : text;
	focus();
}

onMounted(() => {
	if (props.blocker === null) focus();
});

// What "Draft with AI" and the catch-up card work with (the slot's `composer`).
const answer = useTeamComposerAnswerApi({
	body,
	touch: () => {
		touched.value = true;
	},
	focus,
});
const savedReplies = useTeamComposerSavedReplies({
	rootEl,
	textarea,
	body,
	subject: () => subject.value,
	recipient: () => props.recipient,
	touch: () => {
		touched.value = true;
	},
});
// An AI draft's (or a saved reply's) `[[...]]` gaps hold Send and replace the note beside it.
const gaps = useTeamComposerGaps(body, answer, props, () => savedReplies.gapGuarded.value);
const sendKeys = useChordKeys('mod+Enter');
const canSend = computed(
	() =>
		body.value.trim().length > 0 &&
		!props.busy &&
		!props.held &&
		!props.sendHold &&
		!gaps.hold.value
);

/** What the person typed, for keeping it when they leave without sending. */
function snapshot() {
	return { body: body.value, subject: subject.value, touched: touched.value };
}

defineExpose({ focus, reset, fill, insert, snapshot, answer });
</script>

<template>
	<section
		ref="rootEl"
		class="flex min-h-0 flex-1 flex-col"
		data-testid="thread-composer"
		:aria-label="t('dashboard.inbox.detail.composer.label')"
	>
		<!-- Blocked: say why, never offer a box that would fail on submit. -->
		<div v-if="blocker" class="flex items-start gap-3 p-4" data-testid="thread-composer-blocked">
			<Icon name="lucide:reply" class="mt-0.5 size-4 shrink-0 text-text-tertiary" />
			<div class="min-w-0">
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.inbox.detail.composer.replyTo', { name: senderLabel }) }}
				</p>
				<p class="mt-1 text-xs text-text-tertiary">{{ t(REPLY_BLOCKER_KEYS[blocker]) }}</p>
				<div v-if="$slots['blocked-action']" class="mt-2">
					<slot name="blocked-action" />
				</div>
			</div>
		</div>

		<PostboxComposerShell v-else :target="target" class="min-h-0 flex-1">
			<!-- The envelope, folded to one line like the Postbox composer's; the
			     recipient is fixed, so only the subject opens on a click. -->
			<template #envelope>
				<div class="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-sm">
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-text-primary"
						:aria-expanded="subjectOpen"
						data-testid="thread-composer-envelope"
						@click="subjectOpen = !subjectOpen"
					>
						<span class="min-w-0 truncate">
							<span class="font-medium text-text-primary">{{
								t('components.answer.team.to', { name: senderLabel })
							}}</span>
							<template v-if="subject">
								<span class="mx-1.5 text-text-tertiary" aria-hidden="true">·</span>
								<span class="text-text-secondary">{{ subject }}</span>
							</template>
						</span>
						<Icon
							name="lucide:chevron-down"
							class="size-3 shrink-0 text-text-tertiary"
							:class="{ 'rotate-180': subjectOpen }"
							aria-hidden="true"
						/>
					</button>
					<span
						v-if="hasDraft"
						class="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-subtle px-2 py-0.5 text-2xs font-medium text-brand"
						data-testid="thread-composer-draft-hint"
					>
						<Icon name="lucide:sparkles" class="size-3" aria-hidden="true" />
						{{
							edited
								? t('dashboard.inbox.detail.composer.editedDraft')
								: t('dashboard.inbox.detail.composer.agentDraft')
						}}
					</span>
				</div>

				<div v-if="subjectOpen" class="border-b border-border-subtle px-4 py-2">
					<input
						:value="subject"
						type="text"
						class="input w-full text-sm"
						:aria-label="t('dashboard.inbox.detail.composer.subjectLabel')"
						:placeholder="t('dashboard.inbox.detail.composer.subjectLabel')"
						data-testid="thread-composer-subject"
						@input="onSubjectInput"
						@keydown="onKeydown"
					/>
				</div>
			</template>

			<div class="flex flex-1 flex-col gap-3 px-4 py-3">
				<p
					v-if="notice"
					class="flex items-start gap-1.5 text-xs text-text-secondary"
					data-testid="thread-composer-notice"
				>
					<Icon name="lucide:info" class="mt-px size-3.5 shrink-0" aria-hidden="true" />
					{{ t(REPLY_NOTICE_KEYS[notice]) }}
				</p>

				<slot name="above-editor" :composer="answer" />

				<!-- Plain text: the reply is escaped into HTML on the way out. The `;`
				     saved-reply dropdown is anchored under the caret inside it. -->
				<div class="relative flex min-h-48 flex-1 flex-col">
					<textarea
						ref="textarea"
						:value="body"
						class="min-h-48 w-full flex-1 resize-none bg-transparent text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
						:aria-label="t('dashboard.inbox.detail.composer.bodyLabel')"
						:placeholder="t('dashboard.inbox.detail.composer.placeholder')"
						data-testid="thread-composer-body"
						@input="onInput"
						@keydown="onKeydown"
						@click="savedReplies.refreshTrigger"
						@blur="savedReplies.dropdown.close"
					/>
					<PostboxSnippetPicker
						v-if="savedReplies.dropdown.style.value"
						:items="savedReplies.dropdown.items.value"
						:active-index="savedReplies.dropdown.index.value"
						:style="savedReplies.dropdown.style.value"
						@select="savedReplies.dropdown.select"
						@hover="(i) => (savedReplies.dropdown.index.value = i)"
					/>
				</div>
				<PostboxSnippetVariableDialog
					:request="savedReplies.prompt.value"
					@submit="savedReplies.submitPrompt"
					@cancel="savedReplies.cancelPrompt"
				/>

				<!-- What changed against the agent's original, opened from ⋯. -->
				<div
					v-if="diffOpen && hasChanges"
					class="rounded-lg border border-border-subtle bg-bg-surface p-3"
					data-testid="thread-composer-diff"
				>
					<p class="mb-1 text-[11px] font-medium text-text-tertiary">
						{{ t('dashboard.inbox.detail.composer.originalDraft') }}
					</p>
					<p
						class="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-text-tertiary line-through decoration-1"
					>
						{{ diffBase }}
					</p>
				</div>

				<slot name="attachments" />
			</div>

			<template #footer="{ capabilities }">
				<PostboxComposerFooter
					:capabilities="capabilities"
					frame="answer"
					:can-send="canSend"
					:sending="busy"
					:send-label="sendLabel"
					:send-icon="held ? 'lucide:pencil-line' : undefined"
					:menu-label="t('components.answer.team.more')"
					:preflight="preflight"
					:last-saved-label="gaps.note.value ?? ''"
					:saved-replies="savedReplies.footer"
					@send="send"
				>
					<template #send-hint>
						<kbd
							class="hidden font-mono text-2xs text-text-tertiary sm:inline"
							aria-hidden="true"
							>{{ sendKeys.join(' ') }}</kbd
						>
					</template>
					<template #menu="{ close }">
						<ThreadComposerMenu
							:close="close"
							:has-changes="hasChanges"
							:diff-open="diffOpen"
							:edited="edited"
							:has-draft="hasDraft"
							:busy="busy"
							:has-text="!!body.trim()"
							:can-clear="!!body"
							@toggle-diff="diffOpen = !diffOpen"
							@save="emit('save', body, subject)"
							@restore="restoreDraft"
							@write-own="writeOwn"
							@reject="emit('reject')"
						/>
					</template>
					<template #notes>
						<p
							v-if="held && heldReason"
							class="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary"
							data-testid="thread-composer-held"
							role="status"
						>
							<Icon
								name="lucide:pencil-line"
								class="size-3 shrink-0 text-warning"
								aria-hidden="true"
							/>
							<span>{{ heldReason }}</span>
						</p>
						<p
							v-else-if="sendHold"
							class="text-[11px] text-text-tertiary"
							data-testid="thread-composer-send-hold"
							role="status"
						>
							{{ sendHold }}
						</p>
					</template>
				</PostboxComposerFooter>
			</template>
		</PostboxComposerShell>
	</section>
</template>
