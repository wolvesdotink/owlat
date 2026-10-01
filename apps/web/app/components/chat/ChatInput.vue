<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { isMentionHandlePrefix } from '@owlat/shared/chatMentions';

const props = defineProps<{
	/**
	 * Delivers the draft. An awaited callback rather than an event, because the
	 * composer needs the answer: the text and attachments stay put until this
	 * resolves `ok`, so a refused or failed send is still there to retry.
	 */
	send: (text: string, attachmentIds?: Id<'mediaAssets'>[]) => Promise<{ ok: boolean }>;
}>();

const { t } = useI18n();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const pendingAttachments = ref<{ id: Id<'mediaAssets'>; filename: string; mimeType: string }[]>([]);

const { uploadFile, isUploading } = useChatAttachments();

// Mention picker state
const mentionQuery = ref<string | null>(null);
const mentionStart = ref(-1);
const { candidates: mentionCandidates } = useChatMentionSearch(
	// null when no @-mention is in progress → the search is skipped entirely.
	() => mentionQuery.value
);

// True while a send is waiting for the backend; blocks a second send of the
// same draft.
const isSending = ref(false);

const canSend = computed(
	() =>
		(text.value.trim().length > 0 || pendingAttachments.value.length > 0) &&
		!isUploading.value &&
		!isSending.value
);

const recalcMentionQuery = () => {
	const ta = textareaRef.value;
	if (!ta) {
		mentionQuery.value = null;
		mentionStart.value = -1;
		return;
	}
	const caret = ta.selectionStart ?? 0;
	const before = text.value.slice(0, caret);
	const atIndex = before.lastIndexOf('@');
	if (atIndex < 0) {
		mentionQuery.value = null;
		mentionStart.value = -1;
		return;
	}
	// Ensure the @ is at start or after whitespace.
	const charBefore = atIndex === 0 ? ' ' : before[atIndex - 1];
	if (charBefore && !/\s/.test(charBefore)) {
		mentionQuery.value = null;
		mentionStart.value = -1;
		return;
	}
	const fragment = before.slice(atIndex + 1);
	// Same grammar and 64-char cap the server uses to decide who is notified,
	// so the picker closes once the fragment can no longer be a handle.
	if (!isMentionHandlePrefix(fragment)) {
		mentionQuery.value = null;
		mentionStart.value = -1;
		return;
	}
	mentionStart.value = atIndex;
	mentionQuery.value = fragment;
};

const fitTextarea = () => {
	if (textareaRef.value) {
		textareaRef.value.style.height = 'auto';
		textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px';
	}
};

const handleInput = () => {
	fitTextarea();
	recalcMentionQuery();
};

const handleKeydown = (event: KeyboardEvent) => {
	if (event.key === 'Enter' && !event.shiftKey && mentionQuery.value === null) {
		event.preventDefault();
		void handleSend();
	}
	if (event.key === 'Escape' && mentionQuery.value !== null) {
		mentionQuery.value = null;
		mentionStart.value = -1;
	}
};

const handlePickMention = (handle: string) => {
	if (mentionStart.value < 0 || !textareaRef.value) return;
	const before = text.value.slice(0, mentionStart.value);
	const ta = textareaRef.value;
	const caret = ta.selectionStart ?? text.value.length;
	const after = text.value.slice(caret);
	text.value = `${before}@${handle} ${after}`;
	mentionQuery.value = null;
	mentionStart.value = -1;
	nextTick(() => {
		ta.focus();
		const pos = (before + '@' + handle + ' ').length;
		ta.setSelectionRange(pos, pos);
	});
};

const handleFilePick = async (event: Event) => {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files ?? []);
	for (const file of files) {
		try {
			const id = await uploadFile(file);
			if (id) {
				pendingAttachments.value.push({
					id,
					filename: file.name,
					mimeType: file.type || 'application/octet-stream',
				});
			}
		} catch {
			// Surfacing the error via the composable's `error` ref would also work;
			// here we silently skip the file (the UI shows isUploading).
		}
	}
	input.value = '';
};

const handlePaste = async (event: ClipboardEvent) => {
	const files = Array.from(event.clipboardData?.files ?? []);
	if (files.length === 0) return;
	event.preventDefault();
	for (const file of files) {
		try {
			const id = await uploadFile(file);
			if (id) {
				pendingAttachments.value.push({
					id,
					filename: file.name || 'pasted-file',
					mimeType: file.type || 'application/octet-stream',
				});
			}
		} catch {
			// no-op
		}
	}
};

const removeAttachment = (id: Id<'mediaAssets'>) => {
	pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
};

const handleSend = async () => {
	if (!canSend.value) return;
	// Freeze what is being sent. The draft stays on screen, and editable, until
	// the backend accepts it; then only this snapshot is taken away.
	const submittedText = text.value;
	const submittedIds = pendingAttachments.value.map((a) => a.id);
	mentionQuery.value = null;
	mentionStart.value = -1;
	isSending.value = true;
	let outcome: { ok: boolean };
	try {
		outcome = await props.send(
			submittedText.trim(),
			submittedIds.length > 0 ? submittedIds : undefined
		);
	} finally {
		isSending.value = false;
	}
	// Refused or failed: the operation has toasted it, the draft is kept.
	if (!outcome.ok) return;

	// Text typed after pressing Send follows the sent text, so the sent prefix
	// goes and the rest stays. A draft edited inside the sent part no longer
	// starts with it and is left alone: it is not what was sent.
	if (text.value.startsWith(submittedText)) {
		text.value = text.value.slice(submittedText.length);
	}
	pendingAttachments.value = pendingAttachments.value.filter((a) => !submittedIds.includes(a.id));
	nextTick(fitTextarea);
};
</script>

<template>
	<div class="border-t border-border-subtle bg-bg-elevated px-4 py-3 relative">
		<!-- Mention picker (above input) -->
		<ChatMentionPicker
			v-if="mentionQuery !== null && mentionCandidates.length > 0"
			:candidates="mentionCandidates"
			@pick="handlePickMention"
		/>

		<!-- Pending attachments -->
		<div v-if="pendingAttachments.length > 0" class="flex flex-wrap gap-2 mb-2">
			<div
				v-for="attachment in pendingAttachments"
				:key="attachment.id"
				class="flex items-center gap-2 px-2 py-1 bg-bg-surface border border-border-subtle rounded text-xs"
			>
				<Icon name="lucide:paperclip" class="w-3 h-3 text-text-tertiary" />
				<span class="text-text-secondary truncate max-w-[180px]">{{ attachment.filename }}</span>
				<button
					class="text-text-tertiary hover:text-error"
					@click="removeAttachment(attachment.id)"
					:aria-label="
						t('components.chat.chatInput.removeAttachment', { filename: attachment.filename })
					"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</div>
		</div>

		<div class="flex items-end gap-2">
			<button
				class="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
				:disabled="isUploading"
				:title="t('components.chat.chatInput.attachFile')"
				@click="fileInputRef?.click()"
			>
				<Icon v-if="!isUploading" name="lucide:paperclip" class="w-4 h-4" />
				<UiSpinner v-else size="xs" />
			</button>
			<input ref="fileInputRef" type="file" multiple class="hidden" @change="handleFilePick" />

			<textarea
				ref="textareaRef"
				v-model="text"
				:placeholder="t('components.chat.chatInput.placeholder')"
				rows="1"
				class="flex-1 resize-none bg-bg-surface border border-border-subtle rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
				@keydown="handleKeydown"
				@input="handleInput"
				@paste="handlePaste"
			/>

			<!-- Send is `.btn-primary` — monochrome by design. A solid terracotta
			     fill pinned to the bottom of a full-height pane is the most saturated
			     thing on the screen, and the design language reserves the accent for
			     small marks. UiButton also brings the disabled state (`opacity-50`),
			     which used to be a third hand-written recipe here. The geometry
			     classes keep the 40x40 square affordance against `.btn`'s pill. -->
			<UiButton
				variant="primary"
				:disabled="!canSend"
				class="flex-shrink-0 w-10 h-10 p-0 rounded-xl"
				:aria-label="t('common.send')"
				:aria-busy="isSending || undefined"
				data-testid="chat-send"
				@click="handleSend"
			>
				<Icon
					v-if="isSending"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:send" class="w-4 h-4" />
			</UiButton>
		</div>

		<p class="text-[11px] text-text-tertiary mt-1.5 px-1">
			{{ t('components.chat.chatInput.hint') }}
		</p>
	</div>
</template>
