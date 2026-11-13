<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode, ComposerSeed } from '~/composables/postbox/usePostboxCompose';
import type { BeforeReady } from '~/composables/postbox/usePostboxComposeRow';
import {
	usePostboxComposerAnswerFrame,
	type BasicEditorHandle,
} from '~/composables/postbox/usePostboxComposerAnswerFrame';
import { usePostboxComposerAnswerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { usePostboxComposerGaps } from '~/composables/postbox/usePostboxComposerGaps';
import { usePostboxComposerHandoff } from '~/composables/postbox/usePostboxComposerHandoff';
import { usePostboxComposerSendChoice } from '~/composables/postbox/usePostboxComposerSendChoice';
import { convertReplyToReplyAll } from '~/utils/postboxReplyDefault';
import { mailboxComposerTarget } from '~/utils/composerTarget';
import PostboxComposerShell from './PostboxComposerShell.vue';
import PostboxComposerReadReceipt from './PostboxComposerReadReceipt.vue';
import PostboxComposerBody from './PostboxComposerBody.vue';

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
	 * Where the composer is mounted. `page` (default) is the full-page composer
	 * for new mail: the envelope open and To focused until someone is addressed.
	 * `answer` is Answer mode's composer column: the envelope folded to one
	 * line, the quote folded out of the editor and the body focused on mount.
	 * Both put Coach and Revise under ⋯ and the seal line under Send.
	 */
	frame?: 'page' | 'answer';
	/** Answer mode's line for the footer's save-state spot ("2 of 3 asks covered"). */
	statusNote?: string;
	/** The draft has an Answer mode ask session: its `[[...]]` gaps hold Send. */
	askSession?: boolean;
	/** Names the thread knows by address, for the folded envelope ("To Jonas Berg"). */
	recipientNames?: Record<string, string>;
	/** The compose page: apply or offer text it parked on an earlier leave. */
	beforeReady?: BeforeReady;
}>();

const emit = defineEmits<{
	/**
	 * The send went out (or was queued offline). The undo window is already
	 * armed; hosts only do their own bookkeeping (close, collapse, and for a
	 * reply marked `done`, moving on).
	 */
	(e: 'sent', outcome: { scheduled: boolean; done: boolean }): void;
	(e: 'discarded'): void;
	/** Esc from inside the composer; the host decides what it means. */
	(e: 'minimize'): void;
	/** The draft row exists (created by the first autosave, or reopened). */
	(e: 'draft-id', draftId: Id<'mailDrafts'>): void;
	/** The subject as typed, for a host that titles its page with it. */
	(e: 'subject', subject: string): void;
	/**
	 * The row's saved state moved (a save landed, or the reopened row loaded).
	 * Not proof the current text is saved; a host that needs that calls `flush`.
	 */
	(e: 'saved'): void;
}>();

const { t } = useI18n();
const { showOperationError } = useOperationErrorToast();
// The seed names the target; the shell and footer read its capabilities.
const target = mailboxComposerTarget(props.seed);

const compose = usePostboxCompose(props.seed, { beforeReady: props.beforeReady });
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
	isGapGuarded,
	flush,
	send,
	discard,
} = compose;
const inlineImageSources = usePostboxDraftInlineImages(activeDraftId, bodyHtml);
// The selection-rewrite pill is gated on the `ai` flag ONLY (no per-user toggle).
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const aiRewriteEnabled = computed(() => isFeatureEnabled('ai'));

// Sealed Mail (E5): the per-draft seal state, the lock indicator and the
// proceed-or-cancel decision an unsealable draft needs before it can be sent.
const seal = usePostboxComposerSealLock(() => activeDraftId.value ?? undefined, {
	flush,
	onConfirm: (opts) => void handleSend(opts),
});

// Which chips may show a key glyph, and what removing a named blocker does.
const { chipSealStates, lockBindings } = usePostboxComposerSealChips(seal, {
	toAddresses,
	ccAddresses,
	bccAddresses,
});

// Formatting toolbar: floating on selection; the footer "Aa" pins it, per user.
const { persistentToolbar, toggleToolbar } = usePostboxToolbarPreference();

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

// --- Frames. The view state (folded envelope/quote, Coach under ⋯, what is focused
// on mount) lives in its own composable; the draft underneath is the same in both.
const frameView = usePostboxComposerAnswerFrame({
	frame: props.frame ?? 'page',
	bodyHtml,
	hasRecipients: () =>
		toAddresses.value.length + ccAddresses.value.length + bccAddresses.value.length > 0,
});
const { envelopeRef, basicEditor, focusBody, onLineReplyAll } = frameView;
// The body child mounts the basic editor; the frame's handle follows it.
function bindEditor(editor: BasicEditorHandle | null) {
	basicEditor.value = editor;
}

// The draft id for the host's URL, discard, and what the host reads as it leaves.
const { handleDiscard, snapshot } = usePostboxComposerHandoff({
	draftId: activeDraftId,
	toAddresses,
	bodyHtml,
	attachmentCount: () => attachments.value.length,
	discard,
	emitDiscarded: () => emit('discarded'),
	emitDraftId: (id) => emit('draft-id', id),
});
// Discard deletes the saved row, and the hosts leave the composer right after:
// a draft that holds anything asks first, an empty one goes at once.
const confirm = useConfirm();
async function onDiscard() {
	const holdsContent = snapshot().hasContent || subject.value.trim() !== '';
	if (
		holdsContent &&
		!(await confirm({
			title: t('components.postbox.postboxComposer.discardConfirm.title'),
			body: t('components.postbox.postboxComposer.discardConfirm.body'),
			confirmText: t('components.postbox.postboxComposer.discardConfirm.confirm'),
			variant: 'danger',
		}))
	)
		return;
	await handleDiscard();
}
watch(subject, (value) => emit('subject', value), { immediate: true });
watch(lastSavedAt, (at) => {
	if (at !== null) emit('saved');
});

// Scoped OS-level file drops and clipboard attachment pastes.
const { rootEl, bindRoot, dragActive, onDragOver, onDragLeave, onDrop, onPaste } =
	usePostboxComposerDropZone(addFiles);

// An AI draft's `[[...]]` gaps hold Send back until they are filled.
const { gapCount } = usePostboxComposerGaps({ rootEl, bodyHtml });
// Saved replies: the `;` trigger, the footer picker (⌘;), ⌘K while typing here, "Save as reply".
const savedReplies = usePostboxComposerSnippets(props.seed, compose, { rootEl, basicEditor });
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
	askSession: () => props.askSession === true || isGapGuarded.value,
	statusNote: () => props.statusNote,
});
const sendable = computed(() => canSend.value && !gapsHoldSend.value);

defineExpose({
	focusBody,
	flush,
	answer: answerApi,
	snapshot,
	/** Look for device copies again (the compose page stored one). */
	rescanMirror: () => draftMirror.rescan(),
	/** What the compose page parks when it is left. */
	parkable: compose.parkable,
	/** Hear about the draft row once it exists, even after unmount. */
	onCreated: compose.onCreated,
});

// Cmd/Ctrl+Enter send, +Alt the opposite after-reply action, +Shift schedule, Esc
// minimize — bound on the root (capture): each stacked composer handles its own keys.
const { onComposerKeydown, footerSend, sendWith, scheduleAt } = usePostboxComposerSendChoice({
	seed: () => props.seed,
	rootEl,
	canSend: sendable,
	sending,
	isScheduled,
	scheduleOpen,
	send: handleSend,
	onMinimize: () => emit('minimize'),
});
// ⌘; (the saved-reply picker) first, then the composer's own keys.
function onKeydown(event: KeyboardEvent) {
	if (!savedReplies.footer.handleKeydown(event)) onComposerKeydown(event);
}
</script>

<template>
	<PostboxComposerShell
		:ref="bindRoot"
		:target="target"
		:drag-active="dragActive"
		:locked="draftMirror.busy"
		@dragover="onDragOver"
		@dragleave="onDragLeave"
		@drop="onDrop"
		@paste="onPaste"
		@keydown.capture="onKeydown"
	>
		<template #envelope>
			<!-- A scheduled row is read-only (drafts.update rejects it); the banner
			     below is the way back to editing. -->
			<div class="contents" :inert="isScheduled">
				<PostboxComposerEnvelopeLine
					v-if="!frameView.envelopeOpen.value"
					:to-addresses="toAddresses"
					:cc-addresses="ccAddresses"
					:bcc-addresses="bccAddresses"
					:from="fromAddress || availableIdentities[0]?.address || ''"
					:identities="availableIdentities"
					:recipient-names="recipientNames"
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
			</div>
		</template>

		<!-- The shell's scroll region: the strips keep their height (the draft
		     notice leads), the body keeps at least 6rem. -->
		<PostboxComposerDraftNotice :notice="draftNotice" @retry="retryLoad" />

		<!-- Plan idea 7: keystrokes the server row never received, after a crash.
		     Above the editor, because it offers to replace what is in it. -->
		<PostboxDraftRestoreBar :mirror="draftMirror" :read-only="isScheduled" />

		<!-- A scheduled draft is read-only until it is taken back; the banner owns
		     both the "goes out at" line and the unschedule control. -->
		<PostboxComposerScheduledBanner
			:is-scheduled="isScheduled"
			:scheduled-send-at="scheduledSendAt"
			:cancel-schedule="cancelSchedule"
		/>

		<!-- Answer mode's AI bar / ask card (filled by the page). -->
		<slot name="above-editor" :composer="answerApi" />

		<!-- Locked while a Restore replaces the fields (as are envelope and footer). -->
		<div
			class="min-h-24 flex-1 overflow-hidden"
			:class="{ 'pbx-quote-folded': frameView.quoteFolded.value && frameView.hasQuote.value }"
			:inert="draftMirror.busy || isScheduled"
			:aria-busy="draftMirror.busy || undefined"
			data-testid="composer-body"
		>
			<PostboxComposerBody
				v-model:body-html="bodyHtml"
				v-model:body-blocks="bodyBlocks"
				v-model:subject="subject"
				:mailbox-id="seed.mailboxId"
				:composer-mode="composerMode"
				:body-pending="bodyPending"
				:inline-image-sources="inlineImageSources"
				:persistent-toolbar="persistentToolbar"
				:rewrite-enabled="aiRewriteEnabled"
				:embed-image="addInlineImage"
				:on-remove-embedded-image="removeInlineImage"
				:snippets="savedReplies.editorSnippets.value"
				:snippet-insert="savedReplies.snippetInsert.value"
				:bind-editor="bindEditor"
			/>
		</div>
		<PostboxComposerAttachments
			:inert="draftMirror.busy || isScheduled"
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
			:inert="draftMirror.busy || isScheduled"
			v-model:body-html="bodyHtml"
			:ai-enabled="aiRewriteEnabled"
			:mailbox-id="seed.mailboxId"
			:in-reply-to-message-id="seed.inReplyToMessageId"
		/>

		<template #footer="{ capabilities }">
			<PostboxComposerFooter
				v-model:follow-up-remind-at="followUpRemindAt"
				:capabilities="capabilities"
				:send-as="
					availableIdentities.find((i) => i.address === fromAddress) ?? availableIdentities[0]
				"
				:can-send="sendable"
				:sending="sending"
				:is-uploading="isUploading"
				:is-scheduled="isScheduled"
				v-bind="footerSend"
				:show-signature-picker="signatures.length > 0"
				:signatures="signatures"
				:active-signature-id="activeSignatureId"
				:composer-mode="composerMode"
				:body-pending="bodyPending"
				:subject="subject"
				v-model:body-html="bodyHtml"
				:body-blocks="bodyBlocks"
				:inline-image-sources="inlineImageSources"
				:persistent-toolbar="persistentToolbar"
				:preflight="guards.preflight"
				:last-saved-label="footerStatus"
				:has-quote="frameView.hasQuote.value"
				:quote-folded="frameView.quoteFolded.value"
				:advisory-available="aiRewriteEnabled"
				:advisory-open="frameView.advisoryOpen.value"
				:saved-replies="savedReplies.footer"
				:dictation-target="basicEditor"
				@send="sendWith"
				@toggle-quote="frameView.toggleQuote()"
				@toggle-advisory="frameView.toggleAdvisory()"
				@discard="onDiscard"
				@schedule="scheduleOpen = true"
				@add-files="addFiles"
				@signature-change="onSignatureChange"
				@toggle-toolbar="toggleToolbar"
				@switch-mode="switchMode"
			>
				<!-- Sealed Mail (E5): one honest line under Send, shown from the moment
				     the state is being computed. Its unsealed control only REQUESTS
				     the decision; the dialog below is the single source of consent. -->
				<template #notes>
					<PostboxComposerSealLock compact v-bind="lockBindings" />
				</template>
				<template #menu>
					<PostboxComposerReadReceipt :compose="compose" />
				</template>
			</PostboxComposerFooter>
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
				@schedule="scheduleAt"
				@update:seal-confirm-open="seal.setConfirmOpen"
				@confirm-unsealed="seal.confirmUnsealed"
				@confirm-stale="stale.confirm"
			/>
		</template>
	</PostboxComposerShell>
</template>
