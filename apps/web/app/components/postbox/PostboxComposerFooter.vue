<script setup lang="ts">
/**
 * The composer's footer: Send, then what the composer target allows beside it
 * (`capabilities`, from `utils/composerTarget`). A mailbox draft gets the
 * paperclip, scheduling, the reply reminder, the signature picker, "Preview as
 * sent" and the editor modes; a Team inbox reply gets Send, the pre-send checks
 * and its own ⋯ items (the `menu` slot). Props only a mailbox draft uses are
 * optional.
 *
 * Slots: `send-hint` (beside Send), `menu` (first in ⋯, receives `close`),
 * `notes` (under the pre-send checks).
 */
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from '~/composables/postbox/usePostboxCompose';
import type { ComposerTargetCapabilities } from '~/utils/composerTarget';
import type { PreflightFinding } from '~/utils/postboxPreflight';
import { usePostboxInsertAvailability } from '~/composables/postbox/usePostboxInsertAvailability';

const props = defineProps<{
	/** What the composer's target allows; hides the controls it cannot use. */
	capabilities: ComposerTargetCapabilities;
	canSend: boolean;
	sending: boolean;
	/** Send's own label (who holds it, a target's wording); spins while `sending`. */
	sendLabel?: string;
	/** Send's icon when not sending. Default `lucide:send`. */
	sendIcon?: string;
	/** The ⋯ menu's accessible name, when the target words it ("More for this reply"). */
	menuLabel?: string;
	isUploading?: boolean;
	isScheduled?: boolean;
	sendShortcutHint?: string;
	scheduleShortcutHint?: string;
	showSignaturePicker?: boolean;
	signatures?: { _id: Id<'mailSignatures'>; name: string }[];
	activeSignatureId?: Id<'mailSignatures'> | null;
	composerMode?: ComposerMode;
	/** A reopened draft's body has not loaded: mode and signature wait for it. */
	bodyPending?: boolean;
	/** Live subject + blocks, for the read-only "Preview as sent" dialog below. */
	subject?: string;
	bodyBlocks?: EditorBlock[];
	persistentToolbar?: boolean;
	/** Deterministic pre-send findings (plan idea 6); empty means nothing to say. */
	preflight?: PreflightFinding[];
	/** The save state, or what stands in its place (gaps left, asks covered). */
	lastSavedLabel: string;
	/** The identity Send goes out as — named beside the button ("Send · as Support"). */
	sendAs?: { mailboxId: string; label: string } | null;
	/**
	 * Answer mode's footer (plan §04): Send, attach, schedule, the follow-up
	 * chip, ⋯ and the save state on one row; Coach/Revise and Discard live in ⋯,
	 * and "Show quoted text" unfolds the quote the editor keeps out of the way.
	 */
	frame?: 'popup' | 'answer';
	/** The body carries a quoted original (answer frame: offer to show it). */
	hasQuote?: boolean;
	quoteFolded?: boolean;
	/** Coach and Revise are available (AI on) — answer frame lists them in ⋯. */
	advisoryAvailable?: boolean;
	advisoryOpen?: boolean;
}>();

const followUpRemindAt = defineModel<number | null>('followUpRemindAt', {
	default: null,
});
/**
 * The live body: read by "Preview as sent", written by "Insert availability"
 * (which adds the sender's open times above the signature and the quote).
 */
const bodyHtml = defineModel<string>('bodyHtml', { default: '' });

const emit = defineEmits<{
	(e: 'send'): void;
	(e: 'schedule'): void;
	(e: 'add-files', files: FileList | File[]): void;
	(e: 'signature-change', event: Event): void;
	(e: 'toggle-toolbar'): void;
	(e: 'switch-mode', mode: ComposerMode): void;
	(e: 'toggle-quote'): void;
	(e: 'toggle-advisory'): void;
	(e: 'discard'): void;
}>();

const { t } = useI18n();

const answerFrame = computed(() => props.frame === 'answer');
const availability = usePostboxInsertAvailability(bodyHtml);
// The rich body's tools (Preview as sent, editor mode, toolbar) and the draft
// row's own Discard only exist where the target writes an HTML draft row.
const richBody = computed(() => props.capabilities.body === 'html');
const draftRow = computed(() => props.capabilities.persistence === 'autosave');

// Name the inbox beside the Send button, so it is never a guess whose name a
// reply goes out under. The short inbox name (the chip's) when known, else the
// label. Beside, not on: a long name inside the button wrapped it onto two
// lines in the narrow floating composer.
const { byId: inboxById } = useInboxes();
const sendAsName = computed(() => {
	const identity = props.sendAs;
	if (!identity || !props.capabilities.sendAs) return null;
	return inboxById.value.get(identity.mailboxId as Id<'mailboxes'>)?.name ?? identity.label ?? null;
});

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
	<footer class="px-3 py-2 border-t border-border-subtle flex flex-col gap-1.5">
		<!-- Answer mode's row carries schedule and the follow-up chip too, and
		     does not fit a phone (or the narrowest split column) beside "Show
		     quoted text" and the status: the status group wraps to its own line,
		     right-aligned, instead of the buttons painting over it. -->
		<div
			class="flex items-center justify-between gap-x-2 gap-y-1 min-w-0"
			:class="{ 'flex-wrap': answerFrame }"
			data-testid="composer-footer-row"
		>
			<div class="flex items-center gap-2 min-w-0">
				<UiButton
					type="button"
					class="shrink-0 whitespace-nowrap"
					:title="sendTitle"
					:disabled="!canSend || sending || isScheduled"
					data-testid="composer-send"
					@click="emit('send')"
				>
					<Icon
						v-if="sending"
						name="lucide:loader-2"
						class="w-4 h-4 mr-1.5 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else :name="sendIcon ?? 'lucide:send'" class="w-4 h-4 mr-1.5" />
					{{
						sendLabel ??
						(sending ? t('components.postbox.postboxComposerFooter.sending') : t('common.send'))
					}}
				</UiButton>
				<slot name="send-hint" />
				<span
					v-if="sendAsName"
					class="min-w-0 truncate text-xs text-text-tertiary"
					:title="t('components.postbox.postboxComposerFooter.sendAs', { name: sendAsName })"
					data-testid="postbox-send-as"
					>{{ t('components.postbox.postboxComposerFooter.sendAs', { name: sendAsName }) }}</span
				>
				<!-- The composer uploads its own files only onto a draft row; a team
				     reply's files go through the host's panel under the editor. -->
				<template v-if="capabilities.attachments === 'draft'">
					<UiButton
						variant="ghost"
						type="button"
						class="shrink-0"
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
				</template>
				<!-- Answer mode has the room: schedule and the follow-up chip sit on
				     the row itself instead of behind ⋯. -->
				<template v-if="answerFrame">
					<UiButton
						v-if="capabilities.schedule"
						variant="ghost"
						type="button"
						class="shrink-0"
						:title="scheduleShortcutHint"
						:aria-label="t('components.postbox.postboxComposerFooter.scheduleSend')"
						:disabled="!canSend || sending || isScheduled"
						data-testid="composer-schedule"
						@click="emit('schedule')"
					>
						<Icon name="lucide:clock" class="w-4 h-4" />
					</UiButton>
					<PostboxComposerFollowUp
						v-if="capabilities.replyReminder"
						v-model:remind-at="followUpRemindAt"
						v-model:picker-open="followUpPickerOpen"
						:disabled="isScheduled"
					/>
				</template>
				<!-- Secondary controls collapse behind ⋯ to keep the footer
			     lean; the schedule shortcut (Cmd/Ctrl+Shift+Enter) still works. -->
				<PostboxOverflowMenu
					:label="menuLabel ?? t('components.postbox.postboxComposerFooter.moreOptions')"
					align="left"
					direction="up"
				>
					<template #default="{ close }">
						<slot name="menu" :close="close" />
						<div v-if="!answerFrame && capabilities.replyReminder" class="px-3 py-1.5">
							<PostboxComposerFollowUp
								v-model:remind-at="followUpRemindAt"
								v-model:picker-open="followUpPickerOpen"
								:disabled="isScheduled"
							/>
						</div>
						<label
							v-if="showSignaturePicker && capabilities.signatures"
							class="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary"
						>
							<Icon name="lucide:pen-line" class="w-4 h-4 text-text-tertiary" />
							<span>{{ t('components.postbox.postboxComposerFooter.signature') }}</span>
							<select
								:value="activeSignatureId ?? ''"
								:disabled="bodyPending"
								class="ml-auto bg-bg-surface border border-border-subtle rounded px-1.5 py-1 text-xs outline-none"
								:aria-label="t('components.postbox.postboxComposerFooter.signature')"
								@change="emit('signature-change', $event)"
							>
								<option value="">{{ t('common.none') }}</option>
								<option v-for="sig in signatures ?? []" :key="sig._id" :value="sig._id">
									{{ sig.name }}
								</option>
							</select>
						</label>
						<template v-if="richBody">
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
							<!-- The booking page's next open times and link, into the body. -->
							<button
								v-if="availability.isAvailable.value && composerMode !== 'full'"
								type="button"
								role="menuitem"
								class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface disabled:opacity-50"
								:disabled="bodyPending || availability.isInserting.value"
								data-testid="composer-insert-availability"
								@click="
									availability.insertAvailability();
									close();
								"
							>
								<Icon name="lucide:calendar-check" class="w-4 h-4 text-text-tertiary" />
								{{ t('components.postbox.postboxInsertAvailability.menuItem') }}
							</button>
						</template>
						<template v-if="!answerFrame && capabilities.schedule">
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
						</template>
						<!-- Answer mode: Coach and Revise leave the editor's way and wait
						     here; Discard has no title bar to live in. -->
						<template v-if="answerFrame">
							<button
								v-if="advisoryAvailable"
								type="button"
								role="menuitem"
								class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
								:aria-pressed="advisoryOpen"
								data-testid="composer-toggle-advisory"
								@click="
									emit('toggle-advisory');
									close();
								"
							>
								<Icon name="lucide:sparkles" class="w-4 h-4 text-text-tertiary" />
								{{
									advisoryOpen
										? t('components.postbox.postboxComposerFooter.hideCoach')
										: t('components.postbox.postboxComposerFooter.showCoach')
								}}
							</button>
							<button
								v-if="draftRow"
								type="button"
								role="menuitem"
								class="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-bg-surface"
								data-testid="composer-discard"
								@click="
									emit('discard');
									close();
								"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4 text-text-tertiary" />
								{{ t('components.postbox.postboxComposerFooter.discardDraft') }}
							</button>
						</template>
						<template v-if="richBody">
							<div class="border-t border-border-subtle my-1" />
							<div class="px-3 py-1.5">
								<PostboxComposerModeControls
									:mode="composerMode ?? 'simple'"
									:persistent-toolbar="persistentToolbar"
									:switch-disabled="bodyPending"
									@toggle-toolbar="emit('toggle-toolbar')"
									@switch-mode="emit('switch-mode', $event)"
								/>
							</div>
						</template>
					</template>
				</PostboxOverflowMenu>
				<!-- Deliberately a sibling of the ⋯ menu, not slot content: the dialog
			     must survive the panel closing (see followUpPickerOpen above). -->
				<!-- Plan idea 14: read-only, derived from the send path's own builder. -->
				<PostboxPreviewAsSent
					v-if="richBody"
					:open="previewOpen"
					:subject="subject ?? ''"
					:body-html="bodyHtml"
					:body-blocks="bodyBlocks ?? []"
					:composer-mode="composerMode ?? 'simple'"
					@update:open="previewOpen = $event"
				/>
				<PostboxFollowUpDialog
					v-if="capabilities.replyReminder"
					:open="followUpPickerOpen"
					@update:open="followUpPickerOpen = $event"
					@confirm="(ts) => (followUpRemindAt = ts)"
				/>
			</div>
			<div class="ml-auto flex shrink-0 items-center gap-3 text-xs text-text-tertiary">
				<button
					v-if="answerFrame && hasQuote"
					type="button"
					class="hover:text-text-primary hover:underline"
					:aria-pressed="!quoteFolded"
					data-testid="composer-toggle-quote"
					@click="emit('toggle-quote')"
				>
					{{
						quoteFolded
							? t('components.postbox.postboxComposerFooter.showQuote')
							: t('components.postbox.postboxComposerFooter.hideQuote')
					}}
				</button>
				<span data-testid="composer-save-state">{{ lastSavedLabel }}</span>
			</div>
		</div>
		<!-- Plan idea 6: the always-on checks, on their own line under Send so a
		     long list wraps instead of being cut off. Advisory — Send stays
		     enabled, except for an AI draft's gap, which this line explains. -->
		<PostboxComposerPreflightChip :findings="preflight ?? []" />
		<slot name="notes" />
	</footer>
</template>
