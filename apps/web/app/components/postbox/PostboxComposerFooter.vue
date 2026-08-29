<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { PreflightFinding } from '~/utils/postboxPreflight';

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
	/** Live subject + body, for the read-only "Preview as sent" dialog below. */
	subject: string;
	bodyHtml: string;
	bodyBlocks: EditorBlock[];
	persistentToolbar: boolean;
	/** Deterministic pre-send findings (plan idea 6); empty means nothing to say. */
	preflight?: PreflightFinding[];
	lastSavedLabel: string;
}>();

const followUpRemindAt = defineModel<number | null>('followUpRemindAt', {
	default: null,
});

const emit = defineEmits<{
	(e: 'send'): void;
	(e: 'schedule'): void;
	(e: 'add-files', files: FileList | File[]): void;
	(e: 'signature-change', event: Event): void;
	(e: 'toggle-toolbar'): void;
	(e: 'switch-mode', mode: ComposerMode): void;
}>();

const { t } = useI18n();

// While an upload is in flight the Send button is disabled (canSend is false);
// explain the wait in its tooltip instead of showing the keyboard hint.
const sendTitle = computed(() =>
	props.isUploading
		? t('components.postbox.postboxComposerFooter.uploadingTitle')
		: props.sendShortcutHint
);

// The file input lives here alongside the attach button that triggers it; the
// selected files are emitted to the composer, which owns the upload state. On
// desktop the attach button opens the native OS picker instead of the hidden
// input, but the same files flow to the same upload path.
const fileInput = ref<HTMLInputElement | null>(null);
const { isDesktop, pickNativeFiles } = useNativeFilePicker();

// The follow-up toggle sits inside the ⋯ panel, but the picker dialog it opens
// is rendered here, outside the panel: the panel is `v-if`-ed and closes on the
// first click outside it — which includes clicks inside the teleported dialog —
// so a dialog owned by the slot would be unmounted mid-interaction.
const followUpPickerOpen = ref(false);
// Same reason as followUpPickerOpen: the ⋯ panel unmounts on the first click
// outside it, so the preview dialog it opens is rendered as its sibling below.
const previewOpen = ref(false);

async function onAttachClick() {
	if (isDesktop.value) {
		const files = await pickNativeFiles({
			title: t('components.postbox.postboxComposerFooter.attachFiles'),
			multiple: true,
		});
		if (files.length > 0) emit('add-files', files);
		return;
	}
	fileInput.value?.click();
}

function onPickFiles(event: Event) {
	const target = event.target as HTMLInputElement;
	if (target.files) emit('add-files', target.files);
	target.value = '';
}
</script>

<template>
	<footer class="px-3 py-2 border-t border-border-subtle flex items-center justify-between">
		<div class="flex items-center gap-2">
			<UiButton
				type="button"
				:title="sendTitle"
				:disabled="!canSend || sending || isScheduled"
				@click="emit('send')"
			>
				<Icon
					v-if="sending"
					name="lucide:loader-2"
					class="w-4 h-4 mr-1.5 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:send" class="w-4 h-4 mr-1.5" />
				{{ sending ? t('components.postbox.postboxComposerFooter.sending') : t('common.send') }}
			</UiButton>
			<UiButton
				variant="ghost"
				type="button"
				:title="t('components.postbox.postboxComposerFooter.attachFiles')"
				@click="onAttachClick"
			>
				<Icon name="lucide:paperclip" class="w-4 h-4" />
			</UiButton>
			<!-- A proxy for the paperclip button above, opened by `.click()` and
			     never seen or tabbed to. Out of the accessibility tree explicitly:
			     `class="hidden"` is a stylesheet away from being an unlabelled,
			     focusable file field a screen reader would announce. -->
			<input
				ref="fileInput"
				type="file"
				multiple
				class="hidden"
				aria-hidden="true"
				tabindex="-1"
				@change="onPickFiles"
			/>
			<!-- Secondary controls collapse behind ⋯ to keep the footer
			     lean; the schedule shortcut (Cmd/Ctrl+Shift+Enter) still works. -->
			<PostboxOverflowMenu
				:label="t('components.postbox.postboxComposerFooter.moreOptions')"
				align="left"
				direction="up"
			>
				<template #default="{ close }">
					<div class="px-3 py-1.5">
						<PostboxComposerFollowUp
							v-model:remind-at="followUpRemindAt"
							v-model:picker-open="followUpPickerOpen"
							:disabled="isScheduled"
						/>
					</div>
					<label
						v-if="showSignaturePicker"
						class="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary"
					>
						<Icon name="lucide:pen-line" class="w-4 h-4 text-text-tertiary" />
						<span>{{ t('components.postbox.postboxComposerFooter.signature') }}</span>
						<select
							:value="activeSignatureId ?? ''"
							class="ml-auto bg-bg-surface border border-border-subtle rounded px-1.5 py-1 text-xs outline-none"
							:aria-label="t('components.postbox.postboxComposerFooter.signature')"
							@change="emit('signature-change', $event)"
						>
							<option value="">{{ t('common.none') }}</option>
							<option v-for="sig in signatures" :key="sig._id" :value="sig._id">
								{{ sig.name }}
							</option>
						</select>
					</label>
					<div class="border-t border-border-subtle my-1" />
					<!-- Plan idea 14: the HTML, the REAL text/plain alternative and a
					     dark rendering, from the same builder the send path uses. -->
					<button
						type="button"
						role="menuitem"
						class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
						@click="
							previewOpen = true;
							close();
						"
					>
						<Icon name="lucide:scan-eye" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxComposerFooter.previewAsSent') }}
					</button>
					<div class="border-t border-border-subtle my-1" />
					<button
						type="button"
						role="menuitem"
						class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface disabled:opacity-50"
						:title="scheduleShortcutHint"
						:disabled="!canSend || sending || isScheduled"
						@click="
							emit('schedule');
							close();
						"
					>
						<Icon name="lucide:clock" class="w-4 h-4 text-text-tertiary" />
						{{ t('components.postbox.postboxComposerFooter.scheduleSend') }}
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
			<!-- Plan idea 6: the always-on checks, stated beside Send and nowhere
			     else. Advisory — Send stays enabled. -->
			<PostboxComposerPreflightChip :findings="preflight ?? []" />
			<!-- Deliberately a sibling of the ⋯ menu, not slot content: the dialog
			     must survive the panel closing (see followUpPickerOpen above). -->
			<!-- Plan idea 14: read-only, derived from the send path's own builder. -->
			<PostboxPreviewAsSent
				:open="previewOpen"
				:subject="subject"
				:body-html="bodyHtml"
				:body-blocks="bodyBlocks"
				:composer-mode="composerMode"
				@update:open="previewOpen = $event"
			/>
			<PostboxFollowUpDialog
				:open="followUpPickerOpen"
				@update:open="followUpPickerOpen = $event"
				@confirm="(ts) => (followUpRemindAt = ts)"
			/>
		</div>
		<span class="text-xs text-text-tertiary">{{ lastSavedLabel }}</span>
	</footer>
</template>
