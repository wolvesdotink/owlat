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
 *    the draft's AI baseline), exactly once. Only this page's own streams are
 *    applied: one it saw running, or one its own start/answer returned
 *    (the action's result and the subscriptions arrive in either order). A
 *    finished draft found on a reload is already in the saved body, and
 *    applying it again would throw away the edits made since;
 *  - files the server attached (a found file, an answered file question) are
 *    read back into the composer's attachment list;
 *  - a promised date ("It isn't ready yet" → "When can you send it?") arms the
 *    composer's follow-up reminder, as the server did on the draft row.
 */
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { isAlreadyAnsweredRefusal, ownerTimeZone } from '~/utils/answerDraft';

export type AskSession = NonNullable<
	FunctionReturnType<typeof api.mail.ai.composeDraftStore.getSession>
>;
export type AskQuestion = AskSession['questions'][number];
export type AskTarget = FunctionArgs<typeof api.mail.ai.composeDraftStore.getSession>['target'];
export type AskAnswer = FunctionArgs<typeof api.mail.ai.composeDraft.answer>['answers'][number];

type AttachmentRow = { storageId: string; filename: string; contentType: string; size: number };

export type AskPhase = 'idle' | 'checking' | 'asking' | 'drafting' | 'ready' | 'error';

export function useAnswerAskSession(opts: {
	/** The draft the session hangs off, once it exists. */
	target: () => AskTarget | null;
	/** The composer the draft goes into (the page's Answer mode composer). */
	composer: () => AnswerComposerApi | null;
	/** An AI draft just settled in the editor (the asks get checked again). */
	onSettled?: () => void;
	/**
	 * Files the session found or was given, for a target whose reply keeps its
	 * own list (a team thread: the server only reports them, the host attaches).
	 * Called with the files not reported before.
	 */
	onAttachedFiles?: (files: AskSession['attachedFiles']) => void;
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
		// A double submit: the first one is already drafting. No error for that.
		onError: isAlreadyAnsweredRefusal,
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
		// `drafting` with no stream yet: the answers are being applied (a file
		// answer copying) before the draft starts. Busy, not a missing stream.
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

	// Promised dates ("Tomorrow", a weekday, a picked day) and the follow-up
	// reminder resolve to 09:00 on the owner's calendar, not UTC.
	function timeZoneArg(): { timeZone?: string } {
		const timeZone = ownerTimeZone();
		return timeZone ? { timeZone } : {};
	}

	// Which sessions are this page's own. A start replaces the session (a new
	// id); the action's result and the `getSession` subscription arrive in
	// either order, so ownership is decided from both:
	//  - a session first seen while no run of ours is going existed before this
	//    page (a reload): `foreign`, its files and finished stream are history;
	//  - a new id seen while our start is running, when the subscription had
	//    already answered before the run began, is the run's: `own`;
	//  - a new id seen while our start is running but before the subscription
	//    ever answered could be either: `undecided` until the run returns, and
	//    the id the run returns is `own`, any other `foreign`;
	//  - the session an answer is sent on becomes `own` at call time.
	type Ownership = 'own' | 'foreign' | 'undecided';
	const ownership = new Map<string, Ownership>();
	let runsPending = 0;
	/** The session id the subscription showed when the running start began; undefined: not loaded. */
	let idAtRunStart: string | null | undefined;

	function decideFirstSighting(id: string): Ownership {
		if (runsPending === 0) return 'foreign';
		if (idAtRunStart === undefined) return 'undecided';
		return id === idAtRunStart ? 'foreign' : 'own';
	}

	/** Run a start or an answer as this page's own, and take what it returns. */
	async function ownRun(run: () => Promise<{ ok: boolean; result?: AskSession }>) {
		runsPending += 1;
		let view: AskSession | null = null;
		try {
			const result = await run();
			view = result.ok && result.result ? result.result : null;
		} finally {
			runsPending -= 1;
		}
		for (const [id, state] of ownership) {
			if (state === 'undecided' && id !== view?.sessionId) markForeign(id);
		}
		if (!view) return;
		returned.value = view;
		claim(view);
	}

	async function start(instruction: string) {
		const composer = opts.composer();
		if (!composer || busy.value) return;
		// A team thread is its own target; a Postbox reply needs its draft row.
		const known = opts.target();
		const draftId = known?.kind === 'teamThread' ? null : await composer.ensureDraftId();
		const target: AskTarget | null =
			known?.kind === 'teamThread' ? known : draftId ? { kind: 'mailDraft', draftId } : null;
		if (!target) return;
		const trimmed = instruction.trim();
		idAtRunStart =
			sessionQuery.data.value === undefined
				? undefined
				: (sessionQuery.data.value?.sessionId ?? null);
		await ownRun(() =>
			startOp.run({
				target,
				...(trimmed ? { instruction: trimmed } : {}),
				locale: locale.value,
				...timeZoneArg(),
			})
		);
	}

	async function answer(answers: AskAnswer[], skip = false) {
		const current = session.value;
		if (!current || current.status !== 'asking' || answerOp.isLoading.value) return;
		// What this answer brings (a file, the draft) is this page's from now on.
		claim(current);
		await ownRun(() =>
			answerOp.run({
				sessionId: current.sessionId,
				answers,
				...(skip ? { skip: true } : {}),
				...timeZoneArg(),
			})
		);
	}

	/** This page's streams (seen running here, or returned by its own run). */
	const liveStreams = new Set<string>();
	const settledStreams = new Set<string>();

	/** Settle the current stream once it is complete, if it is ours. */
	function reconcileStream() {
		const current = stream.value;
		const composer = opts.composer();
		if (!current || !composer || current.status !== 'complete') return;
		if (!liveStreams.has(current._id) || settledStreams.has(current._id)) return;
		settledStreams.add(current._id);
		void settle(composer, current.text);
	}

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
			reconcileStream();
		},
		{ immediate: true }
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
	// Files for a host that attaches them itself (a team thread): only those of
	// this page's own sessions, each once, by identity.
	const reportedFiles = new Set<string>();
	const fileKey = (file: AskSession['attachedFiles'][number]) => `${file.source}:${file.id}`;

	function reportFiles(view: AskSession) {
		if (!opts.onAttachedFiles) return;
		const fresh = view.attachedFiles.filter((file) => !reportedFiles.has(fileKey(file)));
		if (fresh.length === 0) return;
		for (const file of fresh) reportedFiles.add(fileKey(file));
		opts.onAttachedFiles(fresh);
	}

	/** A session from before this page: its files and its finished stream are history. */
	function markForeign(id: string) {
		ownership.set(id, 'foreign');
		const view = session.value?.sessionId === id ? session.value : null;
		for (const file of view?.attachedFiles ?? []) reportedFiles.add(fileKey(file));
	}

	/** This page's own session: its stream is applied, its files reported. */
	function claim(view: AskSession) {
		ownership.set(view.sessionId, 'own');
		if (view.streamId) liveStreams.add(view.streamId);
		reportFiles(view);
		reconcileStream();
	}

	watch(
		() =>
			[
				session.value?.sessionId ?? null,
				session.value?.streamId ?? null,
				(session.value?.attachedFiles ?? []).map(fileKey).join('|'),
			] as const,
		([id]) => {
			const view = session.value;
			if (!id || !view) return;
			if (!ownership.has(id)) {
				const state = decideFirstSighting(id);
				if (state === 'foreign') markForeign(id);
				else ownership.set(id, state);
			}
			if (ownership.get(id) === 'own') claim(view);
		},
		{ immediate: true }
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
