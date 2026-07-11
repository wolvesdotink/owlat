<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { ComposerPromotePayload } from '~/composables/postbox/usePostboxComposerStack';
import { SIMPLE_BLOCK_TYPES } from '~/composables/postbox/postboxBlockTypes';
import { convertReplyToReplyAll } from '~/utils/postboxReplyDefault';
import { mentionsAttachment } from '~/utils/attachmentMention';

const EmailBuilder = defineAsyncComponent(() =>
	import('@owlat/email-builder').then((m) => m.EmailBuilder)
);

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	draftId?: Id<'mailDrafts'>;
	inReplyToMessageId?: Id<'mailMessages'>;
	prefillTo?: string[];
	prefillCc?: string[];
	prefillBcc?: string[];
	prefillSubject?: string;
	prefillBodyHtml?: string;
	forwardAttachmentsFromMessageId?: Id<'mailMessages'>;
	attachPendingKey?: string;
	initialMode?: ComposerMode;
	/**
	 * On a plain Reply, the extra recipients Reply-All would include. When
	 * non-empty the envelope shows a dismissible "Also include …? (reply-all)"
	 * hint that merges them into Cc.
	 */
	replyAllRecipients?: string[];
	/**
	 * Compact in-place variant (the reader's inline reply box): the header
	 * swaps Minimize for an expand-to-popup button that emits `promote` with
	 * the live draft, and the body editor is focused on mount (inline only
	 * mounts on an explicit user action, so this never steals focus on load).
	 */
	inline?: boolean;
}>();

const emit = defineEmits<{
	(e: 'sent', undoToken: string, sendAt: number): void;
	(e: 'discarded'): void;
	(e: 'minimize'): void;
	(e: 'promote', payload: ComposerPromotePayload): void;
}>();

const {
	toAddresses,
	ccAddresses,
	bccAddresses,
	subject,
	bodyHtml,
	bodyBlocks,
	composerMode,
	fromAddress,
	availableIdentities,
	setIdentity,
	signatures,
	activeSignatureId,
	applySignature,
	attachments,
	uploads,
	attachmentSizeMeter,
	thumbUrlFor,
	addFiles,
	removeAttachment,
	cancelUpload,
	retryUpload,
	addInlineImage,
	removeInlineImage,
	isSaving,
	lastSavedAt,
	isUploading,
	canSend,
	isScheduled,
	scheduledSendAt,
	cancelSchedule,
	followUpRemindAt,
	flush,
	send,
	discard,
} = usePostboxCompose({
	mailboxId: props.mailboxId,
	draftId: props.draftId,
	inReplyToMessageId: props.inReplyToMessageId,
	prefillTo: props.prefillTo,
	prefillCc: props.prefillCc,
	prefillBcc: props.prefillBcc,
	prefillSubject: props.prefillSubject,
	prefillBodyHtml: props.prefillBodyHtml,
	forwardAttachmentsFromMessageId: props.forwardAttachmentsFromMessageId,
	attachPendingKey: props.attachPendingKey,
	initialMode: props.initialMode,
});

// Inline ghost-text autocomplete: gated by the `ai` flag AND the per-user
// toggle; the subject line is the bounded thread context for the prompt.
const { ghostSuggestionsEnabled } = usePostboxGhostGate();
// The selection-rewrite pill is gated on the `ai` flag ONLY (no per-user toggle).
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiRewriteEnabled = computed(() => isFeatureEnabled('ai'));

// Formatting-toolbar preference. Default is the Apple-minimal floating bar (only
// on selection); the footer "Aa" affordance flips back to the classic persistent
// toolbar and persists the choice per user.
const { persistentToolbar, toggleToolbar } = usePostboxToolbarPreference();

// Canned responses ("/" slash-trigger); inert when the mailbox has no snippets.
const { editorSnippets, snippetFirstName } = usePostboxComposerSnippets(
	() => props.mailboxId ?? null,
	() => toAddresses.value[0]
);

async function onFromChange(address: string) {
	try {
		await setIdentity(address);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('[Postbox] setIdentity failed', err);
	}
}

// Reply → Reply-all conversion (the envelope's mode toggle): fold the extra
// recipients into Cc IN PLACE, keeping To / subject / body exactly as-is.
// Dedupe by canonical address (against both Cc and To) so an already-present
// address isn't doubled; self was already excluded when the extras were
// derived. Same recipient math as opening a fresh reply-all.
function onApplyReplyAll() {
	const extras = props.replyAllRecipients ?? [];
	if (extras.length === 0) return;
	const converted = convertReplyToReplyAll(
		{
			to: toAddresses.value,
			cc: ccAddresses.value,
			subject: subject.value,
			bodyHtml: bodyHtml.value,
		},
		extras
	);
	ccAddresses.value = converted.cc;
}

const composerName = ref(`Postbox compose ${new Date().toLocaleString()}`);
const backgroundColor = ref('#ffffff');

const builderConfig = computed(() => ({
	hideSubject: true,
	blockTypes: composerMode.value === 'simple' ? SIMPLE_BLOCK_TYPES : undefined,
}));

function switchMode(target: ComposerMode) {
	composerMode.value = target;
}

// Per-message signature picker (only when the mailbox has ≥1 signature).
const showSignaturePicker = computed(() => signatures.value.length > 0);

function onSignatureChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	applySignature((target.value as Id<'mailSignatures'>) || null);
}

const sending = ref(false);
const scheduleOpen = ref(false);
const { showToast } = useToast();

// Team-inbox collision safety: the guard warns once if a teammate replied to this
// thread after this reply opened (shared inboxes only; inert on personal mail and
// fresh composes). It owns the confirm dialog's open state and retries the send
// via `onConfirm` once acknowledged. Reactive via mailbox.latestReplyState.
const {
	staleReplyByName,
	confirmOpen: staleConfirmOpen,
	blockSend: blockStaleSend,
	confirm: confirmStaleSend,
} = usePostboxStaleReplyGuard(() => props.inReplyToMessageId, {
	onConfirm: (opts) => void handleSend(opts),
});

async function handleSend(opts?: { scheduledSendAt?: number }) {
	// Explain *why* Send is inert while an upload is in flight (Send is disabled
	// via `canSend`, and Cmd/Ctrl+Enter routes here too) so the user waits rather
	// than losing the not-yet-committed attachment. Keep this above the canSend
	// short-circuit so the toast still fires when uploading is the sole blocker.
	if (isUploading.value) {
		showToast('Waiting for attachments to finish uploading…');
		return;
	}
	if (!canSend.value || sending.value) return;
	// Catch the classic "I said 'attached' but forgot to attach" mistake.
	if (
		attachments.value.length === 0 &&
		mentionsAttachment(subject.value, bodyHtml.value) &&
		!window.confirm('Your message mentions an attachment, but none is attached. Send anyway?')
	) {
		return;
	}
	// A teammate replied to this shared-inbox thread after this reply opened —
	// pause for confirmation before sending a duplicate (asked once).
	if (blockStaleSend(opts)) return;
	sending.value = true;
	try {
		// `send()` throws on a backend reject (no_recipients, from_revoked,
		// illegal_edge, scan-block, …). The underlying operation module has
		// already surfaced the categorized error as a toast, so we only need to
		// stay put: do NOT emit `sent` (which would arm undo + navigate away) on
		// failure. A real `{ undoToken, sendAt }` reaching here means it sent.
		const result = await send(opts);
		emit('sent', result.undoToken, result.sendAt);
	} catch (err) {
		// Error already toasted by useBackendOperation; log for telemetry context.
		// eslint-disable-next-line no-console
		console.error('[Postbox] send failed', err);
	} finally {
		sending.value = false;
	}
}

async function handleDiscard() {
	await discard();
	emit('discarded');
}

// --- Inline variant: promote to a normal popup composer. Flush the debounced
// autosave first (creating the draft row if needed) so the popup reopens the
// SAME draft id — no content loss. The live field values ride along so the
// popup seeds instantly instead of waiting for hydration. `focusBody` is
// exposed so the reader's r/a keys can re-focus an already-open inline box.
const { promoting, basicEditor, focusBody, handlePromote } = usePostboxComposerInline({
	inline: props.inline ?? false,
	flush,
	snapshot: () => ({
		toAddresses: [...toAddresses.value],
		ccAddresses: [...ccAddresses.value],
		bccAddresses: [...bccAddresses.value],
		subject: subject.value,
		bodyHtml: bodyHtml.value,
	}),
	emitPromote: (payload) => emit('promote', payload),
});
defineExpose({ focusBody });

const unscheduling = ref(false);
async function handleUnschedule() {
	if (unscheduling.value) return;
	unscheduling.value = true;
	try {
		// Reverts the row to 'draft' — re-enables autosave + editing. Errors are
		// already toasted by useBackendOperation.
		await cancelSchedule();
	} finally {
		unscheduling.value = false;
	}
}

const scheduledLabel = computed(() =>
	scheduledSendAt.value ? formatDateTime(scheduledSendAt.value) : ''
);

const lastSavedLabel = computed(() => {
	if (isSaving.value) return 'Saving…';
	if (!lastSavedAt.value) return '';
	return `Saved ${new Date(lastSavedAt.value).toLocaleTimeString()}`;
});

// Composer root: used both for scoped OS-level file drops (desktop) and the
// keyboard-shortcut binding below.
const rootEl = ref<HTMLElement | null>(null);
const {
	isDragOver: dragActive,
	handleDragOver: onDragOver,
	handleDragLeave: onDragLeave,
	handleDrop: onDrop,
} = useDropZone(
	(files) => {
		void addFiles(files);
	},
	{ osFileDrop: true, rootRef: rootEl }
);

function onPaste(event: ClipboardEvent) {
	const files = Array.from(event.clipboardData?.files ?? []);
	if (files.length > 0) {
		event.preventDefault();
		void addFiles(files);
	}
}

// Keyboard shortcuts (Cmd/Ctrl+Enter send, +Shift schedule, Esc minimize),
// bound on the composer root (capture) so each stacked popup composer only
// handles its own keys.
const { sendShortcutHint, scheduleShortcutHint, onComposerKeydown } = usePostboxComposerKeys({
	rootEl,
	canSend,
	sending,
	isScheduled,
	scheduleOpen,
	onSend: () => void handleSend(),
	onSchedule: () => {
		scheduleOpen.value = true;
	},
	onMinimize: () => emit('minimize'),
});
</script>

<template>
	<div
		ref="rootEl"
		class="relative flex flex-col h-full bg-bg-elevated"
		@dragover="onDragOver"
		@dragleave="onDragLeave"
		@drop="onDrop"
		@paste="onPaste"
		@keydown.capture="onComposerKeydown"
	>
		<div
			v-if="dragActive"
			class="absolute inset-0 z-10 flex items-center justify-center bg-brand/10 border-2 border-dashed border-brand rounded pointer-events-none"
		>
			<span class="text-sm font-medium text-brand"> Drop to attach · drop in text to embed </span>
		</div>
		<header
			class="flex items-center justify-between px-3 py-2 bg-bg-surface border-b border-border-subtle"
		>
			<span class="text-sm font-semibold">
				{{ subject || 'New message' }}
			</span>
			<div class="flex items-center gap-1">
				<button
					v-if="inline"
					type="button"
					class="p-1 hover:bg-bg-elevated rounded"
					title="Open in popup"
					aria-label="Open in popup"
					:disabled="promoting"
					@click="handlePromote"
				>
					<Icon name="lucide:maximize-2" class="w-4 h-4" />
				</button>
				<button
					v-else
					type="button"
					class="p-1 hover:bg-bg-elevated rounded"
					title="Minimize"
					@click="emit('minimize')"
				>
					<Icon name="lucide:minus" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1 hover:bg-bg-elevated rounded"
					title="Discard"
					@click="handleDiscard"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>
		</header>

		<PostboxComposerEnvelope
			v-model:to-addresses="toAddresses"
			v-model:cc-addresses="ccAddresses"
			v-model:bcc-addresses="bccAddresses"
			v-model:subject="subject"
			:mailbox-id="mailboxId"
			:from-address="fromAddress"
			:available-identities="availableIdentities"
			:reply-all-recipients="replyAllRecipients"
			@from-change="onFromChange"
			@apply-reply-all="onApplyReplyAll"
		/>

		<div
			v-if="isScheduled"
			class="flex items-center justify-between gap-3 px-3 py-2 border-b border-border-subtle bg-bg-surface text-sm"
		>
			<span class="inline-flex items-center gap-1.5 text-text-secondary">
				<Icon name="lucide:clock" class="w-4 h-4 text-brand" />
				Scheduled for {{ scheduledLabel }}
			</span>
			<button
				type="button"
				class="btn btn-ghost text-xs"
				:disabled="unscheduling"
				@click="handleUnschedule"
			>
				<Icon v-if="unscheduling" name="lucide:loader-2" class="w-3.5 h-3.5 mr-1 animate-spin" />
				Unschedule to edit
			</button>
		</div>

		<div class="flex-1 overflow-hidden">
			<PostboxBasicEditor
				v-if="composerMode === 'simple'"
				ref="basicEditor"
				v-model="bodyHtml"
				placeholder="Write your message…"
				:suggestions-enabled="ghostSuggestionsEnabled"
				:ghost-thread-context="subject"
				:rewrite-enabled="aiRewriteEnabled"
				:rewrite-mailbox-id="mailboxId"
				:persistent-toolbar="persistentToolbar"
				:emoji-shortcodes-enabled="true"
				:inline-images-enabled="true"
				:embed-image="addInlineImage"
				:on-remove-embedded-image="removeInlineImage"
				:snippets="editorSnippets"
				:snippet-first-name="snippetFirstName"
			/>
			<EmailBuilder
				v-else
				:blocks="bodyBlocks"
				:subject="subject"
				:name="composerName"
				:background-color="backgroundColor"
				:variables="[]"
				:config="builderConfig"
				class="h-full"
				@update:blocks="bodyBlocks = $event"
				@update:subject="subject = $event"
				@update:name="composerName = $event"
				@update:background-color="backgroundColor = $event"
			/>
		</div>

		<PostboxComposerAttachments
			:attachments="attachments"
			:uploads="uploads"
			:meter="attachmentSizeMeter"
			:thumb-url-for="thumbUrlFor"
			@remove="removeAttachment"
			@cancel="cancelUpload"
			@retry="retryUpload"
		/>

		<!-- Advisory AI cluster: "Coach my draft" self-check + freeform whole-draft
		     revise. Advisory only — never sends; hidden when AI is off / draft empty. -->
		<PostboxComposerAdvisory
			v-model:body-html="bodyHtml"
			:ai-enabled="aiRewriteEnabled"
			:mailbox-id="mailboxId"
			:in-reply-to-message-id="inReplyToMessageId"
		/>

		<PostboxComposerFooter
			v-model:follow-up-remind-at="followUpRemindAt"
			:can-send="canSend"
			:sending="sending"
			:is-uploading="isUploading"
			:is-scheduled="isScheduled"
			:send-shortcut-hint="sendShortcutHint"
			:schedule-shortcut-hint="scheduleShortcutHint"
			:show-signature-picker="showSignaturePicker"
			:signatures="signatures"
			:active-signature-id="activeSignatureId"
			:composer-mode="composerMode"
			:persistent-toolbar="persistentToolbar"
			:last-saved-label="lastSavedLabel"
			@send="handleSend()"
			@schedule="scheduleOpen = true"
			@add-files="addFiles"
			@signature-change="onSignatureChange"
			@toggle-toolbar="toggleToolbar"
			@switch-mode="switchMode"
		/>
		<PostboxScheduleDialog
			:open="scheduleOpen"
			@update:open="scheduleOpen = $event"
			@confirm="(ts) => handleSend({ scheduledSendAt: ts })"
		/>
		<!-- Team-inbox collision safety: a teammate replied to this thread after
		     this reply was opened. Confirm before sending a duplicate. -->
		<PostboxStaleReplyDialog
			v-model:open="staleConfirmOpen"
			:reply-by-name="staleReplyByName"
			@confirm="confirmStaleSend"
		/>
	</div>
</template>
