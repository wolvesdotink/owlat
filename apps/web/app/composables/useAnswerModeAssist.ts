/**
 * Everything Answer mode adds around the Postbox composer (plan §03 to §06),
 * wired for the page:
 *
 *  - the reply's response plan (SPEC §6): a stance per open item of the
 *    thread brief, and what the draft addresses ("3 of 4 addressed · 1 needs a
 *    file" in the composer footer, chips on the items, the file-claim banner);
 *  - which conversation view opens: Summary when the thread has a brief, the
 *    full conversation when it has none (nothing interpreted to show);
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
import { useThreadBrief } from '~/composables/useThreadBrief';
import { useResponsePlan } from '~/composables/useResponsePlan';
import { isPlanItem } from '~/utils/responsePlan';
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

	// The thread brief: the plan's items, and the opening view. Summary when
	// the thread has a brief; with none there is nothing to show but the
	// conversation. Decided once, so it never flips under someone who toggled.
	const { view: briefView } = useThreadBrief({ threadId: () => opts.message()?.threadId });
	let viewDecided = false;
	watch(
		briefView,
		(v) => {
			if (viewDecided || v === undefined) return;
			viewDecided = true;
			if (!v || v.completeness === 'none') opts.view.value = 'full';
		},
		{ immediate: true }
	);

	// The response plan over the brief's open items (personal: for you and
	// unclear; a shared mailbox: for the team and unclear).
	const plan = useResponsePlan({
		threadRef: () => {
			const threadId = opts.message()?.threadId;
			return threadId ? { kind: 'mail', id: threadId as Id<'mailThreads'> } : null;
		},
		draftRef: () => {
			const draftId = opts.draftId();
			return draftId ? { kind: 'mailDraft', id: draftId as Id<'mailDrafts'> } : null;
		},
		draftText: () => draftText.value,
		items: () => {
			const v = briefView.value;
			if (!v) return [];
			const ours = v.mode === 'brief' ? v.forYou : v.forTeam;
			return [...ours, ...v.unclear].filter(isPlanItem);
		},
	});

	// Draft with AI
	const ask = useAnswerAskSession({
		target: () => {
			const draftId = opts.draftId();
			return draftId ? { kind: 'mailDraft', draftId: draftId as Id<'mailDrafts'> } : null;
		},
		composer: opts.composer,
		onSettled: () => void plan.checkCoverage(),
		// The drafter reads the stored stances: write the person's choices first.
		beforeDraft: async (target) => {
			if (target.kind === 'mailDraft') await plan.flush({ kind: 'mailDraft', id: target.draftId });
		},
	});

	/** The prepared reply's plan moves to the draft it became (review F16). */
	async function adoptPrepared(composer: AnswerComposerApi) {
		const draftId = await composer.ensureDraftId();
		if (draftId) await plan.adoptPreparedPlan(draftId);
	}

	// A draft the AI prepared earlier.
	const prepared = useAnswerPreparedDraft({
		threadId: () => opts.message()?.threadId,
		enabled: () => aiEnabled.value && opts.freshReply(),
	});
	let preparedTaken = false;
	/** The prepared reply put in the editor, so the queue's copy of it is not applied again. */
	let appliedText: string | null = null;
	watch(
		() => [prepared.text.value, opts.composer()] as const,
		([text, composer]) => {
			if (preparedTaken || !text || !composer) return;
			preparedTaken = true;
			// Something is already written (a suggested lead, a restored draft).
			if (composer.draftText.value.trim()) return;
			appliedText = text;
			void composer
				.applyAiDraft(text)
				.then(() => adoptPrepared(composer))
				.then(() => prepared.attachFiles(composer))
				.then(() => plan.checkCoverage());
		},
		{ immediate: true }
	);

	/**
	 * The Reply Queue's starter reply, written after the person answered its
	 * questions on this page: into the editor, with the files they gave as
	 * answers (the invoices the draft now says are attached).
	 */
	async function applyQueueDraft(composer: AnswerComposerApi, text: string): Promise<void> {
		// A reply written while no draft was waiting reaches the prepared-draft
		// watcher above too (one thread patch flips both): whichever runs first
		// takes it, so its files are attached once. A second upload attach would
		// fail and say so.
		if (appliedText === text) return;
		preparedTaken = true;
		appliedText = text;
		await composer.applyAiDraft(text);
		await adoptPrepared(composer);
		await prepared.attachFiles(composer);
		void plan.checkCoverage();
	}

	// Files from the thread.
	const threadFiles = useAnswerThreadFiles({
		mailboxId: () => opts.message()?.mailboxId as Id<'mailboxes'> | undefined,
	});
	const { upload } = useAnswerFileUpload();
	const attachExisting = useBackendOperation(api.mail.drafts.attachExisting, {
		label: () => t('components.answer.threadFiles.attachOperation'),
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
			else showToast(t('components.answer.threadFiles.attachFailed'), 'error');
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
			showToast(t('components.answer.threadFiles.attachFailed'), 'error');
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
		plan,
		statusNote: plan.statusNote,
		ask,
		attaching,
		attachThreadFile,
		resolveThreadFile,
		onComposerDrop,
		applyQueueDraft,
	};
}
