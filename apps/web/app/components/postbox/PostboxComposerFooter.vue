<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';

const props = defineProps<{
	canSend: boolean;
	sending: boolean;
	isUploading: boolean;
	isScheduled: boolean;
	sendShortcutHint: string;
	scheduleShortcutHint: string;
	showSignaturePicker: boolean;
	signatures: { _id: Id<'mailSignatures'>; name: string }[];
	activeSignatureId: Id<'mailSignatures'> | null;
	composerMode: ComposerMode;
	persistentToolbar: boolean;
	lastSavedLabel: string;
}>();

const followUpRemindAt = defineModel<number | null>('followUpRemindAt', {
	default: null,
});

const emit = defineEmits<{
	(e: 'send'): void;
	(e: 'schedule'): void;
	(e: 'add-files', files: FileList): void;
	(e: 'signature-change', event: Event): void;
	(e: 'toggle-toolbar'): void;
	(e: 'switch-mode', mode: ComposerMode): void;
}>();

// While an upload is in flight the Send button is disabled (canSend is false);
// explain the wait in its tooltip instead of showing the keyboard hint.
const sendTitle = computed(() =>
	props.isUploading ? 'Waiting for attachments to finish uploading…' : props.sendShortcutHint
);

// The file input lives here alongside the attach button that triggers it; the
// selected FileList is emitted to the composer, which owns the upload state.
const fileInput = ref<HTMLInputElement | null>(null);

function onPickFiles(event: Event) {
	const target = event.target as HTMLInputElement;
	if (target.files) emit('add-files', target.files);
	target.value = '';
}
</script>

<template>
	<footer class="px-3 py-2 border-t border-border-subtle flex items-center justify-between">
		<div class="flex items-center gap-2">
			<button
				type="button"
				class="btn btn-primary"
				:title="sendTitle"
				:disabled="!canSend || sending || isScheduled"
				@click="emit('send')"
			>
				<Icon
					v-if="sending"
					name="lucide:loader-2"
					class="w-4 h-4 mr-1.5 animate-spin"
				/>
				<Icon v-else name="lucide:send" class="w-4 h-4 mr-1.5" />
				{{ sending ? 'Sending…' : 'Send' }}
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
					@change="emit('signature-change', $event)"
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
			<!-- Secondary controls (schedule send, Simple/Designer mode + the
			     formatting-toolbar toggle) collapse behind ⋯ to keep the footer
			     lean; the schedule shortcut (Cmd/Ctrl+Shift+Enter) still works. -->
			<PostboxOverflowMenu
				label="More compose options"
				align="left"
				direction="up"
			>
				<template #default="{ close }">
					<button
						type="button"
						role="menuitem"
						class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface disabled:opacity-50"
						:title="scheduleShortcutHint"
						:disabled="!canSend || sending || isScheduled"
						@click="emit('schedule'); close()"
					>
						<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
						Schedule send…
					</button>
					<div class="border-t border-border-subtle my-1" />
					<div class="px-3 py-1.5">
						<PostboxComposerModeControls
							:mode="composerMode"
							:persistent-toolbar="persistentToolbar"
							@toggle-toolbar="emit('toggle-toolbar')"
							@switch-mode="emit('switch-mode', $event)"
						/>
					</div>
				</template>
			</PostboxOverflowMenu>
		</div>
		<span class="text-xs text-text-tertiary">{{ lastSavedLabel }}</span>
	</footer>
</template>
