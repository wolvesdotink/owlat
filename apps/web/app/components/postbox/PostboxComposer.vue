<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { ComposerPromotePayload } from '~/composables/postbox/usePostboxComposerStack';
import { SIMPLE_BLOCK_TYPES } from '~/composables/postbox/postboxBlockTypes';

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
	isUploading,
	addFiles,
	removeAttachment,
	isSaving,
	lastSavedAt,
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
const { data: persistentToolbar, set: setPersistentToolbar } = useLocalStorage(
	'postbox-composer-persistent-toolbar',
	false,
);
function toggleToolbar() {
	setPersistentToolbar(!persistentToolbar.value);
}

async function onFromChange(address: string) {
	try {
		await setIdentity(address);
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('[Postbox] setIdentity failed', err);
	}
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

const ATTACHMENT_HINT = /\b(attach(ed|ment|ing|ments)?|enclosed)\b/i;

/** Catch the classic "I said 'attached' but forgot to attach" mistake. */
function missingAttachmentWarning(): boolean {
	if (attachments.value.length > 0) return false;
	const text = `${subject.value} ${bodyHtml.value.replace(/<[^>]+>/g, ' ')}`;
	return ATTACHMENT_HINT.test(text);
}

async function handleSend(opts?: { scheduledSendAt?: number }) {
	if (!canSend.value || sending.value) return;
	if (
		missingAttachmentWarning() &&
		!window.confirm('Your message mentions an attachment, but none is attached. Send anyway?')
	) {
		return;
	}
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
// popup seeds instantly instead of waiting for hydration.
const promoting = ref(false);
async function handlePromote() {
	if (promoting.value) return;
	promoting.value = true;
	try {
		const id = await flush();
		emit('promote', {
			draftId: id,
			toAddresses: [...toAddresses.value],
			ccAddresses: [...ccAddresses.value],
			bccAddresses: [...bccAddresses.value],
			subject: subject.value,
			bodyHtml: bodyHtml.value,
		});
	} finally {
		promoting.value = false;
	}
}

// Focus the inline body editor on mount (simple mode only — the Designer
// mode's builder manages its own focus). Exposed so the reader's r/a keys can
// re-focus an already-open inline box.
const basicEditor = ref<{ focus: () => void } | null>(null);
function focusBody() {
	basicEditor.value?.focus();
}
onMounted(() => {
	if (props.inline) void nextTick(() => focusBody());
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
	scheduledSendAt.value ? formatDateTime(scheduledSendAt.value) : '',
);

const lastSavedLabel = computed(() => {
	if (isSaving.value) return 'Saving…';
	if (!lastSavedAt.value) return '';
	return `Saved ${new Date(lastSavedAt.value).toLocaleTimeString()}`;
});

const fileInput = ref<HTMLInputElement | null>(null);
const {
	isDragOver: dragActive,
	handleDragOver: onDragOver,
	handleDragLeave: onDragLeave,
	handleDrop: onDrop,
} = useDropZone((files) => {
	void addFiles(files);
});

function onPickFiles(event: Event) {
	const target = event.target as HTMLInputElement;
	if (target.files) void addFiles(target.files);
	target.value = '';
}

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
const rootEl = ref<HTMLElement | null>(null);
const { sendShortcutHint, scheduleShortcutHint, onComposerKeydown } =
	usePostboxComposerKeys({
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
			<span class="text-sm font-medium text-brand">Drop files to attach</span>
		</div>
		<header class="flex items-center justify-between px-3 py-2 bg-bg-surface border-b border-border-subtle">
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
			@from-change="onFromChange"
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
				<Icon
					v-if="unscheduling"
					name="lucide:loader-2"
					class="w-3.5 h-3.5 mr-1 animate-spin"
				/>
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

		<div
			v-if="attachments.length > 0 || isUploading"
			class="px-3 py-2 border-t border-border-subtle flex flex-wrap gap-2"
		>
			<span
				v-for="att in attachments"
				:key="att.storageId"
				class="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded bg-bg-surface text-xs"
			>
				<Icon name="lucide:paperclip" class="w-3 h-3 text-text-tertiary" />
				<span class="truncate max-w-[140px]">{{ att.filename }}</span>
				<span class="text-text-tertiary">{{ formatCompactFileSize(att.size) }}</span>
				<button
					type="button"
					class="p-0.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
					:aria-label="`Remove ${att.filename}`"
					@click="removeAttachment(att.storageId)"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
			<span v-if="isUploading" class="inline-flex items-center gap-1 text-xs text-text-tertiary">
				<Icon name="lucide:loader-2" class="w-3 h-3 animate-spin" />
				Uploading…
			</span>
		</div>

		<footer class="px-3 py-2 border-t border-border-subtle flex items-center justify-between">
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="btn btn-primary"
					:title="sendShortcutHint"
					:disabled="!canSend || sending || isScheduled"
					@click="handleSend()"
				>
					<Icon
						v-if="sending"
						name="lucide:loader-2"
						class="w-4 h-4 mr-1.5 animate-spin"
					/>
					<Icon v-else name="lucide:send" class="w-4 h-4 mr-1.5" />
					{{ sending ? 'Sending…' : 'Send' }}
				</button>
				<button
					type="button"
					class="btn btn-ghost"
					:title="scheduleShortcutHint"
					:disabled="!canSend || sending || isScheduled"
					@click="scheduleOpen = true"
				>
					<Icon name="lucide:clock" class="w-4 h-4" />
				</button>
				<PostboxComposerFollowUp
					v-model:remind-at="followUpRemindAt"
					:disabled="isScheduled"
				/>
				<button
					type="button"
					class="btn btn-ghost"
					title="Attach files"
					@click="fileInput?.click()"
				>
					<Icon name="lucide:paperclip" class="w-4 h-4" />
				</button>
				<input
					ref="fileInput"
					type="file"
					multiple
					class="hidden"
					@change="onPickFiles"
				>
				<button
					v-if="composerMode === 'simple'"
					type="button"
					class="btn btn-ghost"
					:class="{ 'text-brand': persistentToolbar }"
					:aria-pressed="persistentToolbar"
					:title="persistentToolbar ? 'Hide formatting toolbar (show on selection)' : 'Show formatting toolbar'"
					@click="toggleToolbar"
				>
					<Icon name="lucide:type" class="w-4 h-4" />
				</button>
				<div
					class="inline-flex items-center gap-0.5 bg-bg-surface rounded text-xs border border-border-subtle"
				>
					<button
						type="button"
						class="px-2 py-1 rounded"
						:class="composerMode === 'simple' ? 'bg-bg-elevated text-brand font-medium' : 'text-text-secondary hover:text-text-primary'"
						title="Basic blocks only (text, image, button, divider, list)"
						@click="switchMode('simple')"
					>
						Simple
					</button>
					<button
						type="button"
						class="px-2 py-1 rounded"
						:class="composerMode === 'full' ? 'bg-bg-elevated text-brand font-medium' : 'text-text-secondary hover:text-text-primary'"
						title="All blocks (heroes, columns, tables, …)"
						@click="switchMode('full')"
					>
						Designer
					</button>
				</div>
				<label
					v-if="showSignaturePicker"
					class="inline-flex items-center gap-1 text-xs text-text-tertiary"
					title="Signature"
				>
					<Icon name="lucide:pen-line" class="w-3.5 h-3.5" />
					<select
						:value="activeSignatureId ?? ''"
						class="bg-bg-surface border border-border-subtle rounded px-1.5 py-1 text-xs text-text-secondary outline-none"
						aria-label="Signature"
						@change="onSignatureChange"
					>
						<option value="">No signature</option>
						<option
							v-for="sig in signatures"
							:key="sig._id"
							:value="sig._id"
						>
							{{ sig.name }}
						</option>
					</select>
				</label>
			</div>
			<span class="text-xs text-text-tertiary">{{ lastSavedLabel }}</span>
		</footer>
		<PostboxScheduleDialog
			:open="scheduleOpen"
			@update:open="scheduleOpen = $event"
			@confirm="(ts) => handleSend({ scheduledSendAt: ts })"
		/>
	</div>
</template>
