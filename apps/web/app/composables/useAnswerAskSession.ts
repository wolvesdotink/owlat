/**
 * "Draft with AI" that asks first (plan §05, §06), from the composer's side.
 *
 * `start` sends the optional instruction; the server checks for gaps and
 * either asks (the session goes `asking` and the ask card shows its questions)
 * or drafts at once (`drafting`, the text streams into an `aiDraftStreams`
 * buffer). `answer` sends the answers (or skips) and the same thing happens
 * again: a second round, or the draft.
 *
 * The session lives on the server and is read through a subscription, so a
 * reload lands back on the ask card, and a draft still streaming keeps
 * streaming into the editor. What this composable adds on top:
 *
 *  - the streamed text goes into the editor as it arrives, and once the
 *    stream is complete it is settled as the editor's content (and recorded as
 *    the draft's AI baseline). Only streams seen running in this page are
 *    applied: a finished draft found on a reload is already in the saved body,
 *    and applying it again would throw away the edits made since;
 *  - files the server attached (a found file, an answered file question) are
 *    read back into the composer's attachment list;
 *  - a promised date ("It isn't ready yet" → "When can you send it?") arms the
 *    composer's follow-up reminder, as the server did on the draft row.
 */
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';

export type AskSession = NonNullable<
	FunctionReturnType<typeof api.mail.ai.composeDraftStore.getSession>
>;
export type AskQuestion = AskSession['questions'][number];
export type AskTarget = FunctionArgs<typeof api.mail.ai.composeDraftStore.getSession>['target'];
export type AskAnswer = FunctionArgs<typeof api.mail.ai.composeDraft.answer>['answers'][number];

type AttachmentRow = { storageId: string; filename: string; contentType: string; size: number };

export type AskPhase ='idle' | 'checking' | 'asking' | 'drafting' | 'ready' | 'error';

export function useAnswerAskSession(opts: {
	/** The draft the session hangs off, once it exists. */
	target: () => AskTarget | null;
	/** The composer the draft goes into (the page's Answer mode composer). */
	composer: () => AnswerComposerApi | null;
	/** An AI draft just settled in the editor (the asks get checked again). */
	onSettled?: () => void;
}) {
	const { t, locale } = useI18n();

	const sessionQuery = useConvexQuery(api.mail.ai.composeDraftStore.getSession, () => {
		const target = opts.target();
		return target ? { target } : ('skip' as const);
	});
	/** The last view an action returned, until the subscription has caught up. */
	const returned = shallowRef<AskSession | null>(null);
	const session = computed<AskSession | null>(() => {
		const live = sessionQuery.data.value ?? null;
		const mine = returned.value;
		if (!live) return mine;
		if (!mine || mine.sessionId !== live.sessionId) return live;
		return mine.updatedAt > live.updatedAt ? mine : live;
	});

	const startOp = useBackendOperation(api.mail.ai.composeDraft.start, {
		label: () => t('components.answer.aiBar.operation'),
		type: 'action',
		announce: false,
	});
	const answerOp = useBackendOperation(api.mail.ai.composeDraft.answer, {
		label: () => t('components.answer.askCard.operation'),
		type: 'action',
		announce: false,
	});

	const streamId = computed(() => session.value?.streamId ?? null);
	const streamQuery = useConvexQuery(
		api.mail.draftStreamStore.getDraftStream,
		() => (streamId.value ? { streamId: streamId.value } : ('skip' as const)),
		{ keepPreviousData: false }
	);
	const stream = computed(() => {
		const data = streamQuery.data.value;
		return data && streamId.value && data._id === streamId.value ? data : null;
	});

	const phase = computed<AskPhase>(() => {
		if (startOp.isLoading.value && !session.value) return 'checking';
		const current = session.value;
		if (!current) return startOp.isLoading.value ? 'checking' : 'idle';
		if (current.status === 'drafting' && stream.value?.status === 'complete') return 'ready';
		if (current.status === 'drafting' && stream.value?.status === 'error') return 'error';
		return current.status;
	});
	/** A start or an answer is on its way, or a draft is being written. */
	const busy = computed(
		() =>
			startOp.isLoading.value ||
			answerOp.isLoading.value ||
			phase.value === 'checking' ||
			phase.value === 'drafting'
	);

	async function start(instruction: string) {
		const composer = opts.composer();
		if (!composer || busy.value) return;
		const draftId = await composer.ensureDraftId();
		if (!draftId) return;
		const trimmed = instruction.trim();
		const result = await startOp.run({
			target: { kind: 'mailDraft', draftId },
			...(trimmed ? { instruction: trimmed } : {}),
			locale: locale.value,
		});
		if (result.ok) returned.value = result.result;
	}

	async function answer(answers: AskAnswer[], skip = false) {
		const current = session.value;
		if (!current || current.status !== 'asking' || answerOp.isLoading.value) return;
		const result = await answerOp.run({
			sessionId: current.sessionId,
			answers,
			...(skip ? { skip: true } : {}),
		});
		if (result.ok) returned.value = result.result;
	}

	// ── The draft, into the editor ───────────────────────────────────────────
	/** Streams seen running here: only these are applied when they finish. */
	const liveStreams = new Set<string>();
	const settledStreams = new Set<string>();

	watch(
		() => [stream.value?._id, stream.value?.status, stream.value?.text] as const,
		([id, status, text]) => {
			const composer = opts.composer();
			if (!id || !composer) return;
			if (status === 'streaming') {
				liveStreams.add(id);
				if (text) composer.streamAiDraft(text);
				return;
			}
			if (status !== 'complete' || !liveStreams.has(id) || settledStreams.has(id)) return;
			settledStreams.add(id);
			void settle(composer, text ?? '');
		},
		{ immediate: true }
	);
	// A start that drafted at once: its stream may have finished before the
	// subscription ever saw it running.
	watch(
		() => startOp.isLoading.value || answerOp.isLoading.value,
		(running, wasRunning) => {
			if (running || !wasRunning) return;
			const id = streamId.value;
			if (id && !settledStreams.has(id)) liveStreams.add(id);
			const current = stream.value;
			if (id && current?.status === 'complete' && !settledStreams.has(id)) {
				const composer = opts.composer();
				if (!composer) return;
				settledStreams.add(id);
				void settle(composer, current.text);
			}
		}
	);

	async function settle(composer: AnswerComposerApi, text: string) {
		if (text.trim()) await composer.applyAiDraft(text);
		const current = session.value;
		if (current?.followUpAt !== undefined) composer.setFollowUp(current.followUpAt);
		await refreshAttachments(composer);
		opts.onSettled?.();
	}

	/** The attachments the server added (a found file, a file answer). */
	async function refreshAttachments(composer: AnswerComposerApi) {
		const target = opts.target();
		if (target?.kind !== 'mailDraft') return;
		try {
			const draft = await requireConvex().query(api.mail.drafts.get, {
				draftId: target.draftId as Id<'mailDrafts'>,
			});
			const attachments = (draft as { attachments?: AttachmentRow[] } | null)?.attachments;
			if (attachments) composer.setAttachments(attachments);
		} catch {
			// The chips catch up on the next open; the files are on the draft.
		}
	}
	// A file answered mid-session is on the draft before the draft is written.
	watch(
		() => session.value?.attachedFiles.length ?? 0,
		(count, previous) => {
			const composer = opts.composer();
			if (composer && count > (previous ?? 0)) void refreshAttachments(composer);
		}
	);

	return {
		session,
		phase,
		busy,
		/** The stream flagged instructions from the mail in the draft. */
		injectionFlagged: computed(() => stream.value?.injectionFlagged === true),
		start,
		answer,
	};
}
