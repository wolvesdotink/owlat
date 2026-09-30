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
 * The composer answers a `teamThread` composer target (`utils/composerTarget`),
 * so the checks the Postbox composer runs before a send apply here too, as far
 * as that target allows: the same advisory preflight chip beside Send.
 *
 * Presentation only: the page owns the mutations (`useTeamThreadComposer`) and
 * receives `send` (with whether the text differs from the agent draft, and the
 * subject), `save` and `reject`.
 */
import PostboxComposerPreflightChip from '~/components/postbox/PostboxComposerPreflightChip.vue';
import { composerPreflight, type TeamThreadComposerTarget } from '~/utils/composerTarget';
import { useTeamComposerAnswerApi } from '~/composables/useTeamComposerAnswerApi';
import { useTeamComposerGaps } from '~/composables/useTeamComposerGaps';
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
const canSend = computed(
	() =>
		body.value.trim().length > 0 &&
		!props.busy &&
		!props.held &&
		!props.sendHold &&
		!gaps.hold.value
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
}

function onSubjectInput(event: Event) {
	touched.value = true;
	subject.value = (event.target as HTMLInputElement).value;
}

/**
 * Now, when the textarea is there (Answer mode's phone "Reply to…" needs the
 * focus inside the tap for iOS to raise the keyboard), and again after the
 * render for callers that have just made it appear.
 */
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
	focus();
}

function restoreDraft() {
	touched.value = false;
	body.value = props.draft ?? '';
	subject.value = props.subject ?? '';
}

function onKeydown(event: KeyboardEvent) {
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
// An AI draft's `[[...]]` gaps hold Send and replace the note beside it.
const gaps = useTeamComposerGaps(body, answer, props);

/** What the person typed, for keeping it when they leave without sending. */
function snapshot() {
	return { body: body.value, subject: subject.value, touched: touched.value };
}

defineExpose({ focus, reset, fill, insert, snapshot, answer });

const menuItem =
	'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-surface disabled:opacity-50';
</script>

<template>
	<section
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

		<template v-else>
			<!-- The envelope, folded to one line; the subject opens on a click. -->
			<div
				class="flex items-center gap-2 border-b border-border-subtle px-4 py-2 text-xs text-text-tertiary"
			>
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left hover:text-text-primary"
					:aria-expanded="subjectOpen"
					data-testid="thread-composer-envelope"
					@click="subjectOpen = !subjectOpen"
				>
					<span class="truncate">
						{{ t('components.answer.team.to', { name: senderLabel }) }}
						<template v-if="subject"> <span aria-hidden="true"> · </span>{{ subject }} </template>
					</span>
					<Icon
						name="lucide:chevron-down"
						class="size-3 shrink-0"
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

			<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
				<p
					v-if="notice"
					class="flex items-start gap-1.5 text-xs text-text-secondary"
					data-testid="thread-composer-notice"
				>
					<Icon name="lucide:info" class="mt-px size-3.5 shrink-0" aria-hidden="true" />
					{{ t(REPLY_NOTICE_KEYS[notice]) }}
				</p>

				<slot name="above-editor" :composer="answer" />

				<textarea
					ref="textarea"
					:value="body"
					class="min-h-48 w-full flex-1 resize-none bg-transparent text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
					:aria-label="t('dashboard.inbox.detail.composer.bodyLabel')"
					:placeholder="t('dashboard.inbox.detail.composer.placeholder')"
					data-testid="thread-composer-body"
					@input="onInput"
					@keydown="onKeydown"
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

			<footer class="flex flex-col gap-1.5 border-t border-border-subtle px-4 py-3">
				<PostboxComposerPreflightChip :findings="preflight" />
				<div class="flex items-center gap-2">
					<UiButton
						size="sm"
						:disabled="!canSend"
						:loading="busy"
						:aria-disabled="held ? 'true' : undefined"
						data-testid="thread-composer-send"
						@click="send"
					>
						<Icon
							:name="held ? 'lucide:pencil-line' : 'lucide:send'"
							class="size-3.5"
							aria-hidden="true"
						/>
						{{ sendLabel }}
					</UiButton>
					<kbd class="hidden font-mono text-2xs text-text-tertiary sm:inline" aria-hidden="true"
						>⌘↵</kbd
					>
					<span
						v-if="gaps.note.value"
						class="ml-auto text-xs text-text-tertiary"
						data-testid="thread-composer-status"
						>{{ gaps.note.value }}</span
					>
					<PostboxOverflowMenu
						:label="t('components.answer.team.more')"
						align="left"
						direction="up"
					>
						<template #default="{ close }">
							<button
								v-if="hasChanges"
								type="button"
								role="menuitem"
								:class="menuItem"
								data-testid="thread-composer-show-changes"
								@click="(close(), (diffOpen = !diffOpen))"
							>
								<Icon name="lucide:git-compare" class="size-4 text-text-tertiary" />
								{{
									diffOpen
										? t('components.answer.team.hideChanges')
										: t('components.answer.team.showChanges')
								}}
							</button>
							<button
								v-if="edited"
								type="button"
								role="menuitem"
								:class="menuItem"
								:disabled="busy || !body.trim()"
								data-testid="thread-composer-save"
								@click="(close(), emit('save', body, subject))"
							>
								<Icon name="lucide:save" class="size-4 text-text-tertiary" />
								{{ t('dashboard.inbox.detail.composer.saveDraft') }}
							</button>
							<button
								v-if="edited"
								type="button"
								role="menuitem"
								:class="menuItem"
								:disabled="busy"
								data-testid="thread-composer-restore"
								@click="(close(), restoreDraft())"
							>
								<Icon name="lucide:undo-2" class="size-4 text-text-tertiary" />
								{{ t('dashboard.inbox.detail.composer.restoreDraft') }}
							</button>
							<button
								v-if="hasDraft"
								type="button"
								role="menuitem"
								:class="menuItem"
								:disabled="busy"
								data-testid="thread-composer-write-own"
								@click="(close(), writeOwn())"
							>
								<Icon name="lucide:pencil" class="size-4 text-text-tertiary" />
								{{ t('dashboard.inbox.detail.composer.writeOwn') }}
							</button>
							<button
								v-if="hasDraft"
								type="button"
								role="menuitem"
								:class="[menuItem, 'text-error']"
								:disabled="busy"
								data-testid="thread-composer-skip"
								@click="(close(), emit('reject'))"
							>
								<Icon name="lucide:trash-2" class="size-4" />
								{{ t('components.answer.team.discardDraft') }}
							</button>
							<button
								v-else
								type="button"
								role="menuitem"
								:class="menuItem"
								:disabled="busy || !body"
								data-testid="thread-composer-clear"
								@click="(close(), writeOwn())"
							>
								<Icon name="lucide:eraser" class="size-4 text-text-tertiary" />
								{{ t('components.answer.team.clear') }}
							</button>
						</template>
					</PostboxOverflowMenu>
				</div>
				<p
					v-if="held && heldReason"
					class="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary"
					data-testid="thread-composer-held"
					role="status"
				>
					<Icon name="lucide:pencil-line" class="size-3 shrink-0 text-warning" aria-hidden="true" />
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
			</footer>
		</template>
	</section>
</template>
