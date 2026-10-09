/**
 * What Answer mode adds around the Team inbox reply (plan §03 to §06), the
 * team counterpart of `useAnswerModeAssist`:
 *
 *  - the reply's response plan (SPEC §6) over the thread's open actions (for
 *    the team and unclear, from the brief's actions view): a stance per item,
 *    what the draft addresses ("3 of 4 addressed" in the footer), and the
 *    file-claim banner, beside the composer. The plan belongs to the inbound
 *    message the reply answers (its draft), so the agent's own check of its
 *    draft shows at once;
 *  - "Draft with AI" on the thread (`composeDraft` with a `teamThread` target)
 *    and its ask card. The draft streams into the reply; the files it found or
 *    was given come back as `attachedFiles`, which the reply attaches through
 *    `inbox.replyAttachments` (the server does not, for a team thread).
 *
 * Team threads have no catch-up summary (SPEC §7 "Team"): the left column is
 * the team stream with its open actions.
 *
 * "Draft with AI" needs the `ai` flag and the team inbox: the ask session and
 * its stream are read through `answerModeQuery`, which checks the target's own
 * flag, so a team-only instance has it too.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ThreadBriefView } from '../../../api/convex/mail/interpret/briefShape';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { useAnswerAskSession, type AskSession } from '~/composables/useAnswerAskSession';
import { useResponsePlan } from '~/composables/useResponsePlan';
import { briefLocale } from '~/composables/threadBrief/briefApi';
import { isPlanItem } from '~/utils/responsePlan';

export function useAnswerTeamAssist(opts: {
	threadId: () => Id<'conversationThreads'> | null;
	/** The inbound message the reply answers (whose draft the plan belongs to). */
	inboundMessageId: () => Id<'inboundMessages'> | null;
	composer: () => AnswerComposerApi | null;
	/** Attach a file the ask session found or was given. */
	attachFile: (file: AskSession['attachedFiles'][number]) => void;
}) {
	const { locale } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const aiEnabled = computed(() => isEnabled('ai'));
	const draftWithAi = computed(() => aiEnabled.value && isEnabled('inbox'));

	// The thread's open actions (the brief's actions view, first page).
	const brief = useConvexQuery(api.mail.interpret.brief.get, () => {
		const threadId = opts.threadId();
		return threadId
			? { threadRef: { kind: 'team' as const, id: threadId }, locale: briefLocale(locale.value) }
			: ('skip' as const);
	});
	const planItems = computed(() => {
		const v = brief.data.value as ThreadBriefView | null | undefined;
		return v?.mode === 'actions' ? [...v.forTeam, ...v.unclear].filter(isPlanItem) : [];
	});

	const plan = useResponsePlan({
		threadRef: () => {
			const threadId = opts.threadId();
			return threadId ? { kind: 'team', id: threadId } : null;
		},
		draftRef: () => {
			const id = opts.inboundMessageId();
			return id ? { kind: 'inboundDraft', id } : null;
		},
		draftText: () => opts.composer()?.draftText.value ?? '',
		items: () => planItems.value,
	});

	const ask = useAnswerAskSession({
		target: () => {
			const threadId = opts.threadId();
			return draftWithAi.value && threadId ? { kind: 'teamThread', threadId } : null;
		},
		composer: opts.composer,
		onSettled: () => void plan.checkCoverage(),
		onAttachedFiles: (files) => {
			for (const file of files) opts.attachFile(file);
		},
	});

	return { aiEnabled, draftWithAi, plan, statusNote: plan.statusNote, ask };
}
