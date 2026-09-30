/**
 * Everything Answer mode adds around the Postbox composer (plan §03 to §06),
 * wired for the page:
 *
 *  - the catch-up card's data, and the asks it ticks as the draft covers them
 *    ("2 of 3 asks covered" in the composer footer);
 *  - which conversation view opens: Summary when there is a card; with no card
 *    a short thread opens in full, since there is nothing to summarise;
 *  - "Draft with AI" and its ask session;
 *  - a reply the AI prepared before Answer mode opened, put in the editor of a
 *    fresh reply the person has not written in yet;
 *  - files from the thread, attached by click or drop, or given as the answer
 *    to a file question.
 *
 * AI pieces are off when the `ai` flag is.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { useAnswerAskSession } from '~/composables/useAnswerAskSession';
import { useAnswerCatchUp } from '~/composables/useAnswerCatchUp';
import { useAnswerFileUpload } from '~/composables/useAnswerFileUpload';
import { useAnswerPreparedDraft } from '~/composables/useAnswerPreparedDraft';
import { useAnswerThreadFiles } from '~/composables/useAnswerThreadFiles';
import { threadFileFromDrop, type ThreadFile } from '~/utils/answerThreadFiles';
import type { FileAnswerRef } from '~/components/answer/FileAsk.vue';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';

export function useAnswerModeAssist(opts: {
	message: () => { _id: string; mailboxId: string; threadId?: string } | undefined;
	composer: () => AnswerComposerApi | null;
	/** The draft row, once it exists. */
	draftId: () => string | null;
	/** A fresh reply (not a resumed draft, not a forward): it may take a prepared draft. */
	freshReply: () => boolean;
	messageCount: () => number | undefined;
	view: Ref<AnswerConversationView>;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { isEnabled } = useFeatureFlag();
	const aiEnabled = computed(() => isEnabled('ai'));

	const draftText = computed(() => opts.composer()?.draftText.value ?? '');

	// Catch-up, its footer note and the opening view.
	const catchUp = useAnswerCatchUp({
		target: () => {
			const message = opts.message();
			return message ? { kind: 'mail', messageId: message._id as Id<'mailMessages'> } : null;
		},
		draftText: () => draftText.value,
		view: opts.view,
		messageCount: opts.messageCount,
	});

	// Draft with AI
	const ask = useAnswerAskSession({
		target: () => {
			const draftId = opts.draftId();
			return draftId ? { kind: 'mailDraft', draftId: draftId as Id<'mailDrafts'> } : null;
		},
		composer: opts.composer,
		onSettled: () => void catchUp.checkCoverage(),
	});

	// A draft the AI prepared earlier.
	const prepared = useAnswerPreparedDraft({
		threadId: () => opts.message()?.threadId,
		enabled: () => aiEnabled.value && opts.freshReply(),
	});
	let preparedTaken = false;
	watch(
		() => [prepared.text.value, opts.composer()] as const,
		([text, composer]) => {
			if (preparedTaken || !text || !composer) return;
			preparedTaken = true;
			// Something is already written (a suggested lead, a restored draft).
			if (composer.draftText.value.trim()) return;
			void composer.applyAiDraft(text).then(() => catchUp.checkCoverage());
		},
		{ immediate: true }
	);

	// Files from the thread.
	const threadFiles = useAnswerThreadFiles({
		mailboxId: () => opts.message()?.mailboxId as Id<'mailboxes'> | undefined,
	});
	const { upload } = useAnswerFileUpload();
	const attachExisting = useBackendOperation(api.mail.drafts.attachExisting, {
		label: () => t('components.answer.catchUp.attachOperation'),
		type: 'action',
	});
	const attaching = ref<string | null>(null);

	/** Attach a thread file to the reply: copied on the server when indexed, else uploaded. */
	async function attachThreadFile(file: ThreadFile) {
		const composer = opts.composer();
		if (!composer || attaching.value) return;
		attaching.value = file.key;
		try {
			const indexId = await threadFiles.indexIdOf(file);
			if (indexId) {
				const draftId = await composer.ensureDraftId();
				if (!draftId) return;
				const result = await attachExisting.run({
					draftId,
					source: 'mailAttachment',
					id: indexId,
				});
				if (result.ok) composer.setAttachments(result.result);
				return;
			}
			const local = await threadFiles.toFile(file);
			if (local) await composer.addFiles([local]);
			else showToast(t('components.answer.catchUp.attachFailed'), 'error');
		} finally {
			attaching.value = null;
		}
	}

	/** A thread file dropped on a file question: the same file, as an answer. */
	async function resolveThreadFile(file: ThreadFile): Promise<FileAnswerRef | null> {
		const indexId = await threadFiles.indexIdOf(file);
		if (indexId) return { source: 'mailAttachment', id: indexId, filename: file.filename };
		const local = await threadFiles.toFile(file);
		if (!local) {
			showToast(t('components.answer.catchUp.attachFailed'), 'error');
			return null;
		}
		const done = await upload(local);
		return done ? { source: 'upload', id: done.storageId, filename: done.filename } : null;
	}

	/** A drop on the composer: a thread file chip attaches; OS files are the composer's. */
	function onComposerDrop(event: DragEvent) {
		const file = threadFileFromDrop(event.dataTransfer);
		if (file) void attachThreadFile(file);
	}

	return {
		aiEnabled,
		catchUp,
		statusNote: catchUp.statusNote,
		ask,
		attaching,
		attachThreadFile,
		resolveThreadFile,
		onComposerDrop,
	};
}
