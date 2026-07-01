<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

const emit = defineEmits<{
	send: [text: string, attachmentIds?: Id<'mediaAssets'>[]];
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const pendingAttachments = ref<
	{ id: Id<'mediaAssets'>; filename: string; mimeType: string }[]
>([]);

const { uploadFile, isUploading } = useChatAttachments();

// Mention picker state
const mentionQuery = ref<string | null>(null);
const mentionStart = ref(-1);
const { candidates: mentionCandidates } = useChatMentionSearch(
	// null when no @-mention is in progress → the search is skipped entirely.
	() => mentionQuery.value,
);

const canSend = computed(
	() => (text.value.trim().length > 0 || pendingAttachments.value.length > 0) && !isUploading.value,
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
	if (!/^[a-zA-Z0-9_\-.]*$/.test(fragment)) {
		mentionQuery.value = null;
		mentionStart.value = -1;
		return;
	}
	mentionStart.value = atIndex;
	mentionQuery.value = fragment;
};

const handleInput = () => {
	if (textareaRef.value) {
		textareaRef.value.style.height = 'auto';
		textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px';
	}
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
	const trimmed = text.value.trim();
	const attachmentIds = pendingAttachments.value.map((a) => a.id);
	emit('send', trimmed, attachmentIds.length > 0 ? attachmentIds : undefined);
	text.value = '';
	pendingAttachments.value = [];
	mentionQuery.value = null;
	mentionStart.value = -1;
	nextTick(() => {
		if (textareaRef.value) textareaRef.value.style.height = 'auto';
	});
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
				 aria-label="Close">
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</div>
		</div>

		<div class="flex items-end gap-2">
			<button
				class="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
				:disabled="isUploading"
				title="Attach file"
				@click="fileInputRef?.click()"
			>
				<Icon v-if="!isUploading" name="lucide:paperclip" class="w-4 h-4" />
				<UiSpinner v-else size="xs" />
			</button>
			<input
				ref="fileInputRef"
				type="file"
				multiple
				class="hidden"
				@change="handleFilePick"
			/>

			<textarea
				ref="textareaRef"
				v-model="text"
				placeholder="Type a message… use @ to mention"
				rows="1"
				class="flex-1 resize-none bg-bg-surface border border-border-subtle rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand transition-colors"
				@keydown="handleKeydown"
				@input="handleInput"
				@paste="handlePaste"
			/>

			<button
				:disabled="!canSend"
				class="flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors"
				:class="
					canSend
						? 'bg-brand text-white hover:bg-brand/90'
						: 'bg-bg-surface text-text-tertiary border border-border-subtle cursor-not-allowed'
				"
				@click="handleSend"
			 aria-label="Send">
				<Icon name="lucide:send" class="w-4 h-4" />
			</button>
		</div>

		<p class="text-[11px] text-text-tertiary mt-1.5 px-1">
			Enter to send · Shift+Enter for newline · @ to mention · paste or attach files
		</p>
	</div>
</template>
