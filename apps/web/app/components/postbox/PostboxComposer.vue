<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode, ComposerSeed } from '~/composables/postbox/usePostboxCompose';
import { SIMPLE_BLOCK_TYPES } from '~/composables/postbox/postboxBlockTypes';
import { usePostboxComposerAnswerFrame } from '~/composables/postbox/usePostboxComposerAnswerFrame';
import { usePostboxComposerAnswerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { usePostboxComposerGaps } from '~/composables/postbox/usePostboxComposerGaps';
import { usePostboxComposerHandoff } from '~/composables/postbox/usePostboxComposerHandoff';
import { convertReplyToReplyAll } from '~/utils/postboxReplyDefault';

const EmailBuilder = defineAsyncComponent(() =>
	import('@owlat/email-builder').then((m) => m.EmailBuilder)
);

const props = defineProps<{
	/** The one-time seed; handed to usePostboxCompose whole. */
	seed: ComposerSeed;
	/**
	 * On a plain Reply, the extra recipients Reply-All would include. When
	 * non-empty the envelope shows a dismissible "Also include …? (reply-all)"
	 * hint that merges them into Cc.
	 */
	replyAllRecipients?: string[];
	/**
	 * Where the composer is mounted. `popup` (default) is the floating stack's
	 * window. `answer` is Answer mode's composer column: no title bar, the
	 * envelope folded to one line, the quote folded out of the editor, Coach
	 * and Revise under ⋯, and the body focused on mount (Answer mode only
	 * opens on an explicit reply, so this never steals focus on load).
	 */
	frame?: 'popup' | 'answer';
	/** Answer mode's line for the footer's save-state spot ("2 of 3 asks covered"). */
	statusNote?: string;
	/** The draft has an Answer mode ask session: its `[[...]]` gaps hold Send. */
	askSession?: boolean;
}>();

const emit = defineEmits<{
	/**
	 * The send went out (or was queued offline). The undo window is already
	 * armed; hosts only do their own bookkeeping (close, collapse).
	 */
	(e: 'sent', outcome: { scheduled: boolean }): void;
	(e: 'discarded'): void;
	/** Popup: Esc / Minimize. Answer frame: Esc from inside the composer. */
	(e: 'minimize'): void;
	/** Popup reply: continue in Answer mode; the draft row is saved first. */
	(e: 'maximise', draftId: Id<'mailDrafts'>): void;
	/** The draft row exists (created by the first autosave, or reopened). */
	(e: 'draft-id', draftId: Id<'mailDrafts'>): void;
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
	shareAsLink,
	isSharing,
	cancelUpload,
	retryUpload,
	addInlineImage,
	removeInlineImage,
	isSaving,
	lastSavedAt,
	draftMirror,
	draftNotice,
	bodyPending,
	retryLoad,
	isUploading,
	canSend,
	isScheduled,
	scheduledSendAt,
	cancelSchedule,
	followUpRemindAt,
	flush,
	send,
	discard,
} = usePostboxCompose(props.seed);

// Inline ghost-text autocomplete: gated by the `ai` flag AND the per-user
// toggle; the subject line is the bounded thread context for the prompt.
const { ghostSuggestionsEnabled } = usePostboxGhostGate();
// The selection-rewrite pill is gated on the `ai` flag ONLY (no per-user toggle).
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiRewriteEnabled = computed(() => isFeatureEnabled('ai'));

// Sealed Mail (E5): the per-draft seal state, the lock indicator and the
// proceed-or-cancel decision an unsealable draft needs before it can be sent.
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
// The third argument is what a snippet's sender-identity variables resolve to.
const { editorSnippets, snippetVariableContext } = usePostboxComposerSnippets(
	() => props.seed.mailboxId ?? null,
	() => toAddresses.value[0],
	() => ({
		name: availableIdentities.value.find((i) => i.address === fromAddress.value)?.label,
		email: fromAddress.value,
	})
);

async function onFromChange(address: string) {
	try {
		await setIdentity(address);
	} catch (err) {
		// The mutation toasts its own refusals; what lands here is the step
		// before it (the draft row could not be created), said out loud.
		showOperationError(err);
	}
}

// Reply → Reply-all in place (the envelope's mode toggle): the extras join Cc,
// deduped against To and Cc; To, subject and body stay exactly as they are.
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
	// The mode decides which body goes out; it waits for the saved one to load.
	if (bodyPending.value) return;
	composerMode.value = target;
}

function onSignatureChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	applySignature((target.value as Id<'mailSignatures'>) || null);
}

const scheduleOpen = ref(false);

// Every gate a send passes (uploads, seal, the confidence layer, the stale-reply
// check) and the send itself, in one composable; see usePostboxComposerSendGate.
const { sending, handleSend, guards, stale } = usePostboxComposerSendGate({
	seed: () => props.seed,
	identities: () => availableIdentities.value,
	fromAddress: () => fromAddress.value,
	subject: () => subject.value,
	bodyHtml: () => bodyHtml.value,
	recipients: () => [...toAddresses.value, ...ccAddresses.value, ...bccAddresses.value],
	attachmentCount: () => attachments.value.length,
	isUploading: () => isUploading.value,
	canSend: () => sendable.value,
	seal: () => seal,
	send,
	onSent: (outcome) => emit('sent', outcome),
});

// --- Frames. Answer mode's view state (folded envelope/quote, Coach under ⋯)
// lives in its own composable; the draft underneath is the popup's, untouched.
const answerFrame = props.frame === 'answer';
const frameView = usePostboxComposerAnswerFrame({
	active: answerFrame,
	bodyHtml,
	sealBlocked: () => seal.blockingRecipients.length > 0,
});
const { envelopeRef, basicEditor, focusBody, onLineReplyAll } = frameView;

// The draft id for the host's URL, popup reply → Answer mode on a saved row,
// discard, and what the host reads as it leaves.
const { maximising, handleMaximise, handleDiscard, snapshot } = usePostboxComposerHandoff({
	draftId: activeDraftId,
	toAddresses,
	bodyHtml,
	attachmentCount: () => attachments.value.length,
	flush,
	discard,
	emitDiscarded: () => emit('discarded'),
	emitDraftId: (id) => emit('draft-id', id),
	emitMaximise: (id) => emit('maximise', id),
});

// Scoped OS-level file drops and clipboard attachment pastes.
const { rootEl, dragActive, onDragOver, onDragLeave, onDrop, onPaste } =
	usePostboxComposerDropZone(addFiles);

// An AI draft's `[[...]]` gaps hold Send back until they are filled.
const { gapCount } = usePostboxComposerGaps({ rootEl, bodyHtml });
const { answerApi, footerStatus, gapsHoldSend } = usePostboxComposerAnswerApi({
	bodyHtml,
	attachments,
	followUpRemindAt,
	addFiles,
	flush,
	focusBody,
	isSaving,
	lastSavedAt,
	gapCount,
	askSession: () => props.askSession === true,
	statusNote: () => props.statusNote,
});
const sendable = computed(() => canSend.value && !gapsHoldSend.value);

defineExpose({
	focusBody,
	flush,
	answer: answerApi,
	snapshot,
});

// Cmd/Ctrl+Enter send, +Shift schedule, Esc minimize — bound on the composer
// root (capture) so each stacked composer only handles its own keys.
const { sendShortcutHint, scheduleShortcutHint, onComposerKeydown } = usePostboxComposerKeys({
	rootEl,
	canSend: sendable,
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
			v-if="!answerFrame"
			:subject="subject"
			:can-maximise="!!seed.inReplyToMessageId"
			:maximising="maximising"
			@maximise="handleMaximise"
			@minimize="emit('minimize')"
			@discard="handleDiscard"
		/>

		<PostboxComposerEnvelopeLine
			v-if="!frameView.envelopeOpen.value"
			:to-addresses="toAddresses"
			:cc-addresses="ccAddresses"
			:bcc-addresses="bccAddresses"
			:from="fromAddress || availableIdentities[0]?.address || ''"
			:subject="subject"
			:can-reply-all="(replyAllRecipients?.length ?? 0) > 0"
			@expand="frameView.openEnvelope()"
			@reply-all="onLineReplyAll"
		/>
		<!-- Folded, not unmounted: its guard dialogs must stay live. -->
		<PostboxComposerEnvelope
			v-show="frameView.envelopeOpen.value"
			ref="envelopeRef"
			v-model:to-addresses="toAddresses"
			v-model:cc-addresses="ccAddresses"
			v-model:bcc-addresses="bccAddresses"
			v-model:subject="subject"
			:mailbox-id="seed.mailboxId"
			:from-address="fromAddress"
			:available-identities="availableIdentities"
			:reply-all-recipients="replyAllRecipients"
			:guards="guards"
			:seal-states="chipSealStates"
			@from-change="onFromChange"
			@apply-reply-all="onApplyReplyAll"
			@attention="frameView.envelopeAttention.value = $event"
		/>

		<!-- Everything between the envelope and the footer scrolls as one: the strips
		     keep their height (the draft notice leads), the body keeps at least 6rem. -->
		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="composer-scroll">
			<PostboxComposerDraftNotice :notice="draftNotice" @retry="retryLoad" />
			<!-- Sealed Mail (E5): honest seal-lock indicator, shown from the moment the
			     state is being computed. Its unsealed control only REQUESTS the
			     decision — the dialog below is the single source of plaintext consent. -->
			<PostboxComposerSealLock
				:enabled="seal.enabled"
				:seal-state="seal.state"
				:pending="seal.pending"
				:blocking-recipients="seal.blockingRecipients"
				:all-verified="seal.allVerified"
				@request-unsealed="seal.requestUnsealed()"
				@remove-recipient="removeSealBlocker"
			/>

			<!-- Plan idea 7: keystrokes the server row never received, after a crash.
			     Above the editor, because it offers to replace what is in it. -->
			<PostboxDraftRestoreBar
				:entry="draftMirror.restorable"
				@restore="draftMirror.restore"
				@dismiss="draftMirror.dismiss"
			/>

			<!-- A scheduled draft is read-only until it is taken back; the banner owns
			     both the "goes out at" line and the unschedule control. -->
			<PostboxComposerScheduledBanner
				:is-scheduled="isScheduled"
				:scheduled-send-at="scheduledSendAt"
				:cancel-schedule="cancelSchedule"
			/>

			<!-- Answer mode's AI bar / ask card (filled by the page). -->
			<slot name="above-editor" :composer="answerApi" />

			<div
				class="min-h-24 flex-1 overflow-hidden"
				:class="{ 'pbx-quote-folded': frameView.quoteFolded.value && frameView.hasQuote.value }"
				data-testid="composer-body"
			>
				<!-- Withheld until a reopened draft's body loads (see usePostboxCompose). -->
				<div
					v-if="bodyPending"
					class="h-full"
					role="group"
					aria-busy="true"
					:aria-label="t('components.postbox.postboxComposer.bodyLoading')"
				/>
				<PostboxBasicEditor
					v-else-if="composerMode === 'simple'"
					ref="basicEditor"
					v-model="bodyHtml"
					:placeholder="t('components.postbox.postboxComposer.bodyPlaceholder')"
					:suggestions-enabled="ghostSuggestionsEnabled"
					:ghost-thread-context="subject"
					:rewrite-enabled="aiRewriteEnabled"
					:rewrite-mailbox-id="seed.mailboxId"
					:persistent-toolbar="persistentToolbar"
					:emoji-shortcodes-enabled="true"
					:inline-images-enabled="true"
					:embed-image="addInlineImage"
					:on-remove-embedded-image="removeInlineImage"
					:snippets="editorSnippets"
					:snippet-variable-context="snippetVariableContext"
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
				:is-sharing="isSharing"
				:share-disabled="bodyPending"
				@remove="removeAttachment"
				@share="shareAsLink"
				@cancel="cancelUpload"
				@retry="retryUpload"
			/>

			<!-- Advisory AI cluster: "Coach my draft" self-check + freeform whole-draft
			     revise. Advisory only — never sends; hidden when AI is off / draft empty. -->
			<PostboxComposerAdvisory
				v-if="frameView.advisoryOpen.value"
				v-model:body-html="bodyHtml"
				:ai-enabled="aiRewriteEnabled"
				:mailbox-id="seed.mailboxId"
				:in-reply-to-message-id="seed.inReplyToMessageId"
			/>
		</div>

		<PostboxComposerFooter
			v-model:follow-up-remind-at="followUpRemindAt"
			:send-as="
				availableIdentities.find((i) => i.address === fromAddress) ?? availableIdentities[0]
			"
			:can-send="sendable"
			:sending="sending"
			:is-uploading="isUploading"
			:is-scheduled="isScheduled"
			:send-shortcut-hint="sendShortcutHint"
			:schedule-shortcut-hint="scheduleShortcutHint"
			:show-signature-picker="signatures.length > 0"
			:signatures="signatures"
			:active-signature-id="activeSignatureId"
			:composer-mode="composerMode"
			:body-pending="bodyPending"
			:subject="subject"
			:body-html="bodyHtml"
			:body-blocks="bodyBlocks"
			:persistent-toolbar="persistentToolbar"
			:preflight="guards.preflight"
			:last-saved-label="footerStatus"
			:frame="frame"
			:has-quote="frameView.hasQuote.value"
			:quote-folded="frameView.quoteFolded.value"
			:advisory-available="aiRewriteEnabled"
			:advisory-open="frameView.advisoryOpen.value"
			@send="handleSend()"
			@toggle-quote="frameView.toggleQuote()"
			@toggle-advisory="frameView.toggleAdvisory()"
			@discard="handleDiscard"
			@schedule="scheduleOpen = true"
			@add-files="addFiles"
			@signature-change="onSignatureChange"
			@toggle-toolbar="toggleToolbar"
			@switch-mode="switchMode"
		/>
		<!-- Every dialog that PARKS a send until the sender answers: the schedule
		     picker, the unsealed-send decision, the stale-reply warning. Grouped
		     in one component because they share the contract — each confirm
		     replays the very send it interrupted, options and all. -->
		<PostboxComposerDialogs
			v-model:schedule-open="scheduleOpen"
			v-model:stale-open="stale.confirmOpen"
			:mailbox-id="seed.mailboxId"
			:recipients="[...toAddresses, ...ccAddresses, ...bccAddresses]"
			:seal-confirm-open="seal.confirmOpen"
			:seal-state="seal.state"
			:stale-reply-by-name="stale.byName"
			@schedule="(ts: number) => handleSend({ scheduledSendAt: ts })"
			@update:seal-confirm-open="seal.setConfirmOpen"
			@confirm-unsealed="seal.confirmUnsealed"
			@confirm-stale="stale.confirm"
		/>
	</div>
</template>
