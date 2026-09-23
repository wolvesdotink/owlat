<script setup lang="ts">
/**
 * The reply box at the bottom of every Team inbox thread.
 *
 * The thread used to offer only the agent's draft card (Approve & Send / Edit /
 * Reject), so with AI off, a skipped or failed message, or a draft too wrong to
 * edit, a teammate had nowhere to type. This is one composer for all of it:
 *
 *  - An agent draft opens the composer pre-filled with it. "Review & send" is
 *    still the one-click fast path; editing shows what changed against the
 *    agent's original, "Write my own" clears it, "Reject draft" declines it.
 *  - No draft: a collapsed "Reply to …" line that expands into an empty box.
 *  - The message is in a state no reply can go to (still being read, parked for
 *    an answer, already answered): the box stays collapsed and says why.
 *
 * Presentation only: the page owns the mutations and receives `send` (with
 * whether the text differs from the agent draft, and the subject), `save` and
 * `reject`.
 * The send colour and label match the Answer queue (TaskActions' primary).
 */
import TaskActions from '~/components/agent-tasks/TaskActions.vue';
import { REPLY_BLOCKER_KEYS, type ReplyBlocker } from '~/utils/teamThreadReply';

const props = withDefaults(
	defineProps<{
		/** Who a reply goes to, for the collapsed line ("Reply to Ana…"). */
		senderLabel: string;
		/** Why nothing can be sent right now; `null` = the composer can send. */
		blocker?: ReplyBlocker | null;
		/** The working draft to pre-fill with (agent's or a saved edit). */
		draft?: string | null;
		/** The agent's original draft — the "before" of the edit diff. */
		originalDraft?: string | null;
		/** The reply's subject to pre-fill (the draft's, or "Re: …"). */
		subject?: string | null;
		/** Expanded? Two-way, so the page's Reply button and `r` can open it. */
		open?: boolean;
		busy?: boolean;
		/** A teammate is replying right now: sending is held, saving is not. */
		held?: boolean;
		heldReason?: string;
	}>(),
	{
		blocker: null,
		draft: null,
		originalDraft: null,
		subject: null,
		open: false,
		busy: false,
		held: false,
		heldReason: undefined,
	}
);

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
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
const trigger = ref<HTMLButtonElement | null>(null);
const section = ref<HTMLElement | null>(null);

const isOpen = computed(() => props.blocker === null && (props.open || hasDraft.value));

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

// Collapsing swaps the focused textarea for the one-line trigger. Hand focus to
// the trigger so a keyboard or screen-reader user keeps their place instead of
// landing back on <body> — whether Escape/Cancel closed it or the page did
// after a send.
watch(isOpen, (open, wasOpen) => {
	if (open || !wasOpen) return;
	const active = import.meta.client ? document.activeElement : null;
	const focusWasHere =
		!active || active === document.body || (section.value?.contains(active) ?? false);
	if (!focusWasHere) return;
	void nextTick(() => trigger.value?.focus());
});

const subjectEdited = computed(() => subject.value.trim() !== (props.subject ?? '').trim());
const edited = computed(
	() =>
		hasDraft.value && (body.value.trim() !== (props.draft ?? '').trim() || subjectEdited.value)
);
const diffBase = computed(() => props.originalDraft ?? props.draft ?? '');
const showDiff = computed(
	() => hasDraft.value && body.value.trim() !== '' && body.value.trim() !== diffBase.value.trim()
);
const canSend = computed(() => body.value.trim().length > 0 && !props.busy);

watch(
	[isOpen, edited, () => body.value.trim().length > 0],
	([open, isEdited, hasText]) => {
		emit('typing', open && (isEdited || (!hasDraft.value && hasText)));
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

function focus() {
	emit('update:open', true);
	void nextTick(() => {
		textarea.value?.focus();
		textarea.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
	});
}

function send() {
	if (!canSend.value || props.held) return;
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

function cancel() {
	restoreDraft();
	emit('update:open', false);
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		send();
	} else if (event.key === 'Escape' && !hasDraft.value) {
		event.preventDefault();
		cancel();
	}
}

/** After a successful send the page clears the box. */
function reset() {
	touched.value = false;
	body.value = '';
	subject.value = props.subject ?? '';
}

defineExpose({ focus, reset });

const secondaryButton =
	'inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors duration-(--motion-fast) disabled:opacity-50';
</script>

<template>
	<section
		ref="section"
		class="card"
		data-testid="thread-composer"
		:aria-label="t('dashboard.inbox.detail.composer.label')"
	>
		<!-- Blocked: say why, never offer a box that would fail on submit. -->
		<div v-if="blocker" class="flex items-start gap-3" data-testid="thread-composer-blocked">
			<Icon name="lucide:reply" class="mt-0.5 w-4 h-4 shrink-0 text-text-tertiary" />
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

		<!-- Collapsed: one line that opens the box. -->
		<button
			v-else-if="!isOpen"
			ref="trigger"
			type="button"
			class="flex w-full items-center gap-3 rounded-lg text-left text-sm text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast)"
			data-testid="thread-composer-open"
			@click="focus"
		>
			<Icon name="lucide:reply" class="w-4 h-4 shrink-0" />
			<span class="flex-1 truncate">
				{{ t('dashboard.inbox.detail.composer.replyTo', { name: senderLabel }) }}
			</span>
			<kbd
				class="hidden sm:inline px-1 py-px rounded border border-border-subtle bg-bg-surface font-mono text-[10px] text-text-secondary"
				aria-hidden="true"
				>R</kbd
			>
		</button>

		<!-- Open -->
		<div v-else class="space-y-3">
			<div class="flex items-center justify-between gap-3">
				<p class="text-sm font-medium text-text-primary truncate">
					{{ t('dashboard.inbox.detail.composer.replyTo', { name: senderLabel }) }}
				</p>
				<span
					v-if="hasDraft"
					class="inline-flex shrink-0 items-center gap-1 text-xs text-brand"
					data-testid="thread-composer-draft-hint"
				>
					<Icon name="lucide:sparkles" class="w-3.5 h-3.5" aria-hidden="true" />
					{{
						edited
							? t('dashboard.inbox.detail.composer.editedDraft')
							: t('dashboard.inbox.detail.composer.agentDraft')
					}}
				</span>
			</div>

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

			<textarea
				ref="textarea"
				:value="body"
				rows="8"
				class="input w-full text-sm resize-y"
				:aria-label="t('dashboard.inbox.detail.composer.bodyLabel')"
				:placeholder="t('dashboard.inbox.detail.composer.placeholder')"
				data-testid="thread-composer-body"
				@input="onInput"
				@keydown="onKeydown"
			/>

			<!-- What changed against the agent's original, once it differs. -->
			<div
				v-if="showDiff"
				class="rounded-lg border border-border-subtle bg-bg-elevated p-3"
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

			<TaskActions
				:primary-label="
					hasDraft
						? t('dashboard.inbox.detail.composer.reviewAndSend')
						: t('dashboard.inbox.detail.composer.send')
				"
				primary-icon="lucide:send"
				primary-test-id="thread-composer-send"
				:primary-disabled="!canSend"
				:primary-loading="busy"
				:held="held"
				:held-reason="heldReason"
				:skip-label="
					hasDraft ? t('dashboard.inbox.detail.composer.rejectDraft') : t('common.cancel')
				"
				:skip-destructive="hasDraft"
				:skip-disabled="busy"
				skip-test-id="thread-composer-skip"
				:hints="[{ keys: ['⌘', 'Enter'], label: t('dashboard.inbox.detail.composer.sendHint') }]"
				@primary="send"
				@skip="hasDraft ? emit('reject') : cancel()"
			>
				<button
					v-if="edited"
					type="button"
					:class="secondaryButton"
					:disabled="busy || !body.trim()"
					data-testid="thread-composer-save"
					@click="emit('save', body, subject)"
				>
					<Icon name="lucide:save" class="w-3.5 h-3.5" />
					{{ t('dashboard.inbox.detail.composer.saveDraft') }}
				</button>
				<button
					v-if="edited"
					type="button"
					:class="secondaryButton"
					:disabled="busy"
					data-testid="thread-composer-restore"
					@click="restoreDraft"
				>
					<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
					{{ t('dashboard.inbox.detail.composer.restoreDraft') }}
				</button>
				<button
					v-else-if="hasDraft"
					type="button"
					:class="secondaryButton"
					:disabled="busy"
					data-testid="thread-composer-write-own"
					@click="writeOwn"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
					{{ t('dashboard.inbox.detail.composer.writeOwn') }}
				</button>
			</TaskActions>
		</div>
	</section>
</template>
