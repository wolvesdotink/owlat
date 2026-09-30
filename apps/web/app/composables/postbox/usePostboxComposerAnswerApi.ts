/**
 * What Answer mode's page and its AI pieces may do to the composer they sit
 * around (plan §04 to §06), in one object the composer exposes and hands to its
 * `#above-editor` slot:
 *
 *  - read what was written (plain text, for the ask coverage check);
 *  - make sure the draft row exists (an ask session hangs off it);
 *  - stream an AI draft into the editor and then settle it, replacing only the
 *    part the person writes (the quote and signature stay as they were) and
 *    recording the AI's text as the draft's baseline, like every AI draft, so
 *    the edit-learning loop can compare it with what is sent;
 *  - take the AI draft back out ("AI draft · Discard");
 *  - take the attachments the server added, attach dropped files, set the
 *    follow-up reminder a promised date implies, and focus the body.
 *
 * Plus the footer's status line: gaps left, else the host's note ("2 of 3
 * asks covered"), else the save state.
 *
 * `[[...]]` gaps hold Send back only when the AI wrote them: an AI draft went
 * into this composer, or the host says the draft has an ask session (a resumed
 * draft, whose AI text arrived before this composer mounted; the server refuses
 * that send too). Anywhere else double brackets are the person's own text (a
 * wiki link, a template token), and the preflight chip names them as advice.
 */
import { computed, ref, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import { freshDraftText, replaceAnswerText, splitAnswerBody } from '~/utils/answerDraft';

export interface AnswerComposerApi {
	/** What was written, as plain text (no quote, no signature). */
	draftText: Readonly<Ref<string>>;
	/** The AI draft currently in the editor, or null. */
	aiDraft: Readonly<Ref<string | null>>;
	/** The draft row, created (and saved) if it does not exist yet. */
	ensureDraftId: () => Promise<Id<'mailDrafts'> | null>;
	/** Show a draft still streaming in the editor. */
	streamAiDraft: (text: string) => void;
	/** Settle an AI draft in the editor and record it as the draft's baseline. */
	applyAiDraft: (text: string) => Promise<void>;
	/** Put back what was written before the AI draft. */
	discardAiDraft: () => void;
	/** The draft's attachments as the server now has them. */
	setAttachments: (list: readonly ComposerAttachment[]) => void;
	addFiles: (files: File[]) => Promise<void>;
	setFollowUp: (remindAt: number) => void;
	focusBody: () => void;
}

export function usePostboxComposerAnswerApi(opts: {
	bodyHtml: Ref<string>;
	attachments: Ref<ComposerAttachment[]>;
	followUpRemindAt: Ref<number | null>;
	addFiles: (files: File[]) => Promise<void>;
	flush: () => Promise<BackendOperationResult<Id<'mailDrafts'> | null>>;
	focusBody: () => void;
	isSaving: Ref<boolean>;
	lastSavedAt: Ref<number | null>;
	gapCount: Readonly<Ref<number>>;
	/** The host knows of an ask session on this draft (see the header). */
	askSession?: () => boolean;
	/** The host's line for the save-state spot (Answer mode: asks covered). */
	statusNote: () => string | undefined;
}) {
	const { t, locale } = useI18n();
	const recordBaseline = useBackendOperation(api.mail.drafts.update, {
		label: () => t('shared.postbox.usePostboxCompose.saveOperation'),
		announce: false,
	});

	const aiDraft = ref<string | null>(null);
	/** What was written before the AI draft went in, for Discard. */
	let writtenBefore: string | null = null;

	function keepWrittenBefore() {
		if (writtenBefore === null) writtenBefore = splitAnswerBody(opts.bodyHtml.value).fresh;
	}

	const answerApi: AnswerComposerApi = {
		draftText: computed(() => freshDraftText(opts.bodyHtml.value)),
		aiDraft,
		async ensureDraftId() {
			// Only an acknowledged save counts: the row must hold what is on screen.
			const saved = await opts.flush();
			return saved.ok ? saved.result : null;
		},
		streamAiDraft(text) {
			keepWrittenBefore();
			opts.bodyHtml.value = replaceAnswerText(opts.bodyHtml.value, text);
		},
		async applyAiDraft(text) {
			keepWrittenBefore();
			opts.bodyHtml.value = replaceAnswerText(opts.bodyHtml.value, text);
			aiDraft.value = text;
			const saved = await opts.flush();
			if (saved.ok && saved.result) {
				await recordBaseline.run({ draftId: saved.result, aiBaseline: text });
			}
		},
		discardAiDraft() {
			const { tail } = splitAnswerBody(opts.bodyHtml.value);
			opts.bodyHtml.value = `${writtenBefore ?? ''}${tail}`;
			writtenBefore = null;
			aiDraft.value = null;
			opts.focusBody();
		},
		setAttachments(list) {
			opts.attachments.value = list.map((a) => ({
				storageId: a.storageId,
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			}));
		},
		addFiles: (files) => opts.addFiles(files),
		setFollowUp(remindAt) {
			opts.followUpRemindAt.value = remindAt;
		},
		focusBody: () => opts.focusBody(),
	};

	const gapsHoldSend = computed(
		() => opts.gapCount.value > 0 && (aiDraft.value !== null || !!opts.askSession?.())
	);

	const footerStatus = computed(() => {
		if (gapsHoldSend.value) {
			return t(
				'components.postbox.postboxComposerFooter.gapsLeft',
				{ count: opts.gapCount.value },
				opts.gapCount.value
			);
		}
		if (opts.isSaving.value) return t('common.saving');
		const note = opts.statusNote();
		if (note) return note;
		if (!opts.lastSavedAt.value) return '';
		return t('components.postbox.postboxComposer.savedAt', {
			time: new Date(opts.lastSavedAt.value).toLocaleTimeString(locale.value),
		});
	});

	return { answerApi, footerStatus, gapsHoldSend };
}
