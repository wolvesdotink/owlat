<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { ComposerAttachment } from '~/composables/postbox/usePostboxComposeAttachments';
import type { ComposerPromotePayload } from '~/composables/postbox/usePostboxComposerStack';
import { SIMPLE_BLOCK_TYPES } from '~/composables/postbox/postboxBlockTypes';
import { convertReplyToReplyAll } from '~/utils/postboxReplyDefault';

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
	/** Attachment refs already committed to `draftId` (see ComposerSpec). */
	prefillAttachments?: ComposerAttachment[];
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

const { t, locale } = useI18n();
const { showOperationError } = useOperationErrorToast();

const {
	draftId: activeDraftId,
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
	prefillAttachments: props.prefillAttachments,
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

// Sealed Mail (E5): the honest per-draft seal state, the lock indicator and the
// proceed-or-cancel decision an unsealable draft needs before it can be sent —
// all wired in usePostboxComposerSealLock so this file stays focused.
const seal = usePostboxComposerSealLock(() => activeDraftId.value ?? undefined, {
	flush,
	onConfirm: (opts) => void handleSend(opts),
});

// Plan idea 11: which chips may show a key glyph, and what removing a named
// blocker does. Both live in a sibling composable so this file stays focused.
const { chipSealStates, removeSealBlocker } = usePostboxComposerSealChips(seal, {
	toAddresses,
	ccAddresses,
	bccAddresses,
});

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
		// The mutation itself is an Operation and toasts its own refusals; what
		// lands here is the step before it (the draft row could not be created).
		// Logging alone left the From field silently snapped back to the old
		// address with no explanation.
		showOperationError(err);
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

const composerName = ref(
	t('components.postbox.postboxComposer.composerName', {
		timestamp: new Date().toLocaleString(locale.value),
	})
);
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

// The deterministic confidence layer (plan ideas 3, 4, 5, 6, 15). Same
// blockSend + onConfirm replay contract as the seal and stale-reply guards; no
// model involved, so all of it works with the `ai` flag off.
const guards = usePostboxComposerGuards(
	{
		mailboxId: () => props.mailboxId,
		identities: () => availableIdentities.value,
		fromAddress: () => fromAddress.value,
		subject: () => subject.value,
		bodyHtml: () => bodyHtml.value,
		recipients: () => [...toAddresses.value, ...ccAddresses.value, ...bccAddresses.value],
		attachmentCount: () => attachments.value.length,
	},
	{ onConfirm: (opts) => void handleSend(opts) }
);

type SendOptions = { scheduledSendAt?: number; allowUnsealed?: boolean };

async function handleSend(opts?: SendOptions) {
	// Explain *why* Send is inert while an upload is in flight (Send is disabled
	// via `canSend`, and Cmd/Ctrl+Enter routes here too) so the user waits rather
	// than losing the not-yet-committed attachment. Keep this above the canSend
	// short-circuit so the toast still fires when uploading is the sole blocker.
	if (isUploading.value) {
		showToast(t('components.postbox.postboxComposer.uploadingToast'));
		return;
	}
	if (!canSend.value || sending.value) return;
	// Sealed Mail (E5): an unsealable draft stops here until the sender decides
	// (proceed or cancel) — nothing goes out in plaintext by omission.
	if (await seal.blockSend(opts)) return;
	// A send that will fail DMARC, a message missing the attachment it promises,
	// a recipient never written to before — each asked once, each replaying it.
	if (guards.blockSend(opts)) return;
	// A teammate replied to this shared-inbox thread after this reply opened —
	// pause for confirmation before sending a duplicate (asked once).
	if (blockStaleSend(opts)) return;
	sending.value = true;
	try {
		// `send()` throws on a backend reject (no_recipients, from_revoked,
		// illegal_edge, scan-block, …). Those arrive as a SurfacedOperationError,
		// because the operation module has already toasted them; here we only need
		// to stay put: do NOT emit `sent` (which would arm undo + navigate away) on
		// failure. A real `{ undoToken, sendAt }` reaching here means it sent.
		const result = await send(opts);
		emit('sent', result.undoToken, result.sendAt);
	} catch (err) {
		// Anything NOT already surfaced (the draft row could not be created, a
		// throw from the flush before it) gets a toast of its own — this used to
		// be a console line, so a send could fail with the composer just sitting
		// there looking idle.
		showOperationError(err);
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

const lastSavedLabel = computed(() => {
	if (isSaving.value) return t('common.saving');
	if (!lastSavedAt.value) return '';
	return t('components.postbox.postboxComposer.savedAt', {
		time: new Date(lastSavedAt.value).toLocaleTimeString(locale.value),
	});
});

// Scoped OS-level file drops and clipboard attachment pastes.
const { rootEl, dragActive, onDragOver, onDragLeave, onDrop, onPaste } =
	usePostboxComposerDropZone(addFiles);

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
			<span class="text-sm font-medium text-brand">
				{{ t('components.postbox.postboxComposer.dropHint') }}
			</span>
		</div>
		<PostboxComposerHeader
			:subject="subject"
			:inline="inline"
			:promoting="promoting"
			@promote="handlePromote"
			@minimize="emit('minimize')"
			@discard="handleDiscard"
		/>

		<PostboxComposerEnvelope
			v-model:to-addresses="toAddresses"
			v-model:cc-addresses="ccAddresses"
			v-model:bcc-addresses="bccAddresses"
			v-model:subject="subject"
			:mailbox-id="mailboxId"
			:from-address="fromAddress"
			:available-identities="availableIdentities"
			:reply-all-recipients="replyAllRecipients"
			:guards="guards"
			:seal-states="chipSealStates"
			@from-change="onFromChange"
			@apply-reply-all="onApplyReplyAll"
		/>

		<!-- Sealed Mail (E5): honest seal-lock indicator, shown from the moment the
		     state is being computed. Its unsealed control only REQUESTS the
		     decision — the dialog below is the single source of plaintext consent. -->
		<PostboxComposerSealLock
			:enabled="seal.enabled"
			:seal-state="seal.state"
			:pending="seal.pending"
			:blocking-recipients="seal.blockingRecipients"
			@request-unsealed="seal.requestUnsealed()"
			@remove-recipient="removeSealBlocker"
		/>

		<!-- A scheduled draft is read-only until it is taken back; the banner owns
		     both the "goes out at" line and the unschedule control. -->
		<PostboxComposerScheduledBanner
			:is-scheduled="isScheduled"
			:scheduled-send-at="scheduledSendAt"
			:cancel-schedule="cancelSchedule"
		/>

		<div class="flex-1 overflow-hidden">
			<PostboxBasicEditor
				v-if="composerMode === 'simple'"
				ref="basicEditor"
				v-model="bodyHtml"
				:placeholder="t('components.postbox.postboxComposer.bodyPlaceholder')"
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
			:preflight="guards.preflight"
			:last-saved-label="lastSavedLabel"
			@send="handleSend()"
			@schedule="scheduleOpen = true"
			@add-files="addFiles"
			@signature-change="onSignatureChange"
			@toggle-toolbar="toggleToolbar"
			@switch-mode="switchMode"
		/>
		<!-- Plan idea 9: the recipients drive the timezone-aware presets. To/Cc/Bcc
		     together, since the dialog only speaks up when they share ONE zone. -->
		<PostboxScheduleDialog
			:open="scheduleOpen"
			:mailbox-id="mailboxId"
			:recipients="[...toAddresses, ...ccAddresses, ...bccAddresses]"
			@update:open="scheduleOpen = $event"
			@confirm="(ts) => handleSend({ scheduledSendAt: ts })"
		/>
		<!-- Sealed Mail (E5): the decision behind every unsealed send; confirming
		     replays the parked send (scheduled time included) as an explicit act. -->
		<PostboxComposerSealConfirmDialog
			:open="seal.confirmOpen"
			:seal-state="seal.state"
			@update:open="seal.setConfirmOpen"
			@confirm="seal.confirmUnsealed"
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
