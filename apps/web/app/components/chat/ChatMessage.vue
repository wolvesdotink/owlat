<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { splitMentionSegments } from '@owlat/shared/chatMentions';
import type { ChatMessageRow } from '~/composables/chat/useChatRoom';

interface Props {
	message: ChatMessageRow;
	isOwnMessage: boolean;
	currentUserId: string;
	/** The composer's ↑ asked to edit this message: open the editor and focus it. */
	editRequested?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
	edit: [messageId: Id<'chatMessages'>, text: string];
	delete: [messageId: Id<'chatMessages'>];
	/** The inline editor opened or closed; the list keeps an editing row mounted. */
	editing: [messageId: Id<'chatMessages'>, active: boolean];
}>();

const { t, locale } = useI18n();

const isEditing = ref(false);
const editText = ref(props.message.text);
watch(isEditing, (active) => emit('editing', props.message._id, active));

const displayName = computed(() => {
	if (props.message.author.name) return props.message.author.name;
	if (props.message.author.email) return props.message.author.email;
	return t('common.unknown');
});

const avatarSeed = computed(
	() => props.message.author.name ?? props.message.author.email ?? props.message.authorId
);

const formattedTime = computed(() =>
	new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(
		new Date(props.message.createdAt)
	)
);

const isMentioned = computed(() => (props.message.mentions ?? []).includes(props.currentUserId));

// Render the text with @-mentions visually emphasized.
const segments = computed(() => splitMentionSegments(props.message.text));

const editTextareaRef = ref<HTMLTextAreaElement | null>(null);
const editorRef = ref<HTMLElement | null>(null);
// Where focus goes back to once an editor opened from the keyboard closes:
// the composer the ↑ came from, so the next message can be typed at once.
let returnFocusTo: HTMLElement | null = null;

const startEdit = () => {
	if (props.message.deletedAt) return;
	editText.value = props.message.text;
	isEditing.value = true;
};
const closeEdit = () => {
	// The editor's field and its Save/Cancel buttons all unmount on close, so
	// focus held by any of them would fall to <body>. Focus that already sits
	// on <body> (Safari does not focus a clicked button) is lost the same way.
	// Only focus on an element outside the editor is left where it is.
	const active = document.activeElement;
	const focusWillBeLost =
		!active || active === document.body || !!editorRef.value?.contains(active);
	const target = returnFocusTo;
	returnFocusTo = null;
	isEditing.value = false;
	if (focusWillBeLost && target?.isConnected) void nextTick(() => target.focus());
};
const cancelEdit = closeEdit;
const saveEdit = () => {
	const trimmed = editText.value.trim();
	if (!trimmed || trimmed === props.message.text) {
		cancelEdit();
		return;
	}
	emit('edit', props.message._id, trimmed);
	closeEdit();
};

const openEditorFromKeyboard = () => {
	if (props.message.deletedAt) return;
	if (!isEditing.value) startEdit();
	const active = document.activeElement;
	if (active instanceof HTMLElement && active !== document.body) returnFocusTo = active;
	void nextTick(() => {
		const field = editTextareaRef.value;
		if (!field) return;
		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
		field.scrollIntoView?.({ block: 'nearest' });
	});
};
watch(
	() => props.editRequested,
	(requested) => {
		if (requested) openEditorFromKeyboard();
	},
	{ immediate: true }
);

const doDelete = () => {
	emit('delete', props.message._id);
};

const attachmentIds = computed(() => props.message.attachmentIds ?? []);
const hasAttachments = computed(() => attachmentIds.value.length > 0);
const { attachments } = useChatAttachmentDetails(() =>
	hasAttachments.value ? props.message._id : null
);

// AI assistant reply rendering (@assistant messages).
const isAssistant = computed(() => props.message.isAssistant === true);
const aiToolCalls = computed(() => props.message.toolCalls ?? []);
const aiStreaming = computed(() => props.message.aiStatus === 'streaming');
const aiHasText = computed(() => props.message.text.trim().length > 0);
const aiTyping = computed(
	() => aiStreaming.value && !aiHasText.value && aiToolCalls.value.length === 0
);
</script>

<template>
	<div
		class="group flex gap-3 px-2 py-1 rounded transition-colors"
		:class="isMentioned ? 'bg-warning/5 -mx-2' : 'hover:bg-bg-surface/50 -mx-2'"
	>
		<!-- Avatar -->
		<div
			v-if="isAssistant"
			class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex-shrink-0 flex items-center justify-center"
		>
			<Icon name="lucide:sparkles" class="w-4 h-4" />
		</div>
		<UiAvatar
			v-else
			:name="avatarSeed"
			:image="message.author.image"
			size="lg"
			class="flex-shrink-0"
		/>

		<!-- Capped at a reading measure: on a wide screen a message otherwise ran
		     2000px in one line, with its edit/delete actions at the far edge. -->
		<div class="flex-1 min-w-0 max-w-3xl">
			<div class="flex items-baseline gap-2">
				<span class="text-sm font-semibold text-text-primary truncate">{{ displayName }}</span>
				<span class="text-[11px] text-text-tertiary">{{ formattedTime }}</span>
				<span v-if="message.editedAt" class="text-[11px] text-text-tertiary italic">
					{{ t('components.chat.chatMessage.edited') }}
				</span>
			</div>

			<!-- Edit mode -->
			<div v-if="isEditing" ref="editorRef" class="mt-1">
				<textarea
					ref="editTextareaRef"
					v-model="editText"
					rows="2"
					class="w-full input resize-none"
					@keydown.enter.exact.prevent="saveEdit"
					@keydown.escape.prevent="cancelEdit"
				/>
				<div class="flex gap-2 mt-1">
					<UiButton variant="secondary" size="sm" @click="cancelEdit">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton size="sm" @click="saveEdit">{{ t('common.save') }}</UiButton>
				</div>
			</div>

			<!-- Display mode -->
			<template v-else>
				<div v-if="message.deletedAt" class="text-sm text-text-tertiary italic">
					{{ t('components.chat.chatMessage.deleted') }}
				</div>
				<!-- AI assistant reply: tool cards + streamed Markdown -->
				<div v-else-if="isAssistant">
					<AssistantToolCalls v-if="aiToolCalls.length > 0" :tool-calls="aiToolCalls" />
					<div
						v-if="aiTyping"
						class="flex items-center gap-1 py-1"
						:aria-label="t('components.chat.chatMessage.assistantTyping')"
					>
						<span
							class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
							style="animation-delay: 0ms"
						/>
						<span
							class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
							style="animation-delay: 150ms"
						/>
						<span
							class="w-1.5 h-1.5 rounded-full bg-text-tertiary animate-bounce"
							style="animation-delay: 300ms"
						/>
					</div>
					<div v-else-if="aiHasText" class="relative">
						<AssistantMarkdown :source="message.text" />
						<span
							v-if="aiStreaming"
							class="inline-block w-1.5 h-4 align-text-bottom bg-text-secondary animate-pulse motion-reduce:animate-none ml-0.5"
						/>
					</div>
					<!-- Refused for budget: said in the reader's language. -->
					<AiBudgetRefusal v-if="message.budgetRefusal" :refusal="message.budgetRefusal" />
				</div>
				<div
					v-else
					class="text-sm leading-relaxed whitespace-pre-wrap break-words text-text-primary"
				>
					<template v-for="(segment, idx) in segments" :key="idx">
						<span
							v-if="segment.kind === 'mention'"
							class="px-1 py-0.5 rounded bg-brand-subtle text-brand font-medium"
							>{{ segment.value }}</span
						>
						<template v-else>{{ segment.value }}</template>
					</template>
				</div>

				<!-- Attachments -->
				<div v-if="hasAttachments" class="mt-2 flex flex-wrap gap-2">
					<ChatAttachmentChip
						v-for="attachment in attachments"
						:key="attachment._id"
						:attachment="attachment"
					/>
				</div>
			</template>
		</div>

		<!-- Hover actions -->
		<div
			v-if="!isEditing && !message.deletedAt && isOwnMessage"
			class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex items-start gap-1"
		>
			<UiTooltip :text="t('common.edit')">
				<button
					class="w-7 h-7 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary flex items-center justify-center"
					type="button"
					:aria-label="t('common.edit')"
					@click="startEdit"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
				</button>
			</UiTooltip>
			<UiTooltip :text="t('common.delete')">
				<button
					class="w-7 h-7 rounded hover:bg-bg-elevated text-text-tertiary hover:text-error flex items-center justify-center"
					type="button"
					:aria-label="t('common.delete')"
					@click="doDelete"
				>
					<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
				</button>
			</UiTooltip>
		</div>
	</div>
</template>
