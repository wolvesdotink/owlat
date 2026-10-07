/**
 * What Answer mode adds around the Team inbox reply (plan §03 to §06), the
 * team counterpart of `useAnswerModeAssist`: "Draft with AI" on the thread
 * (`composeDraft` with a `teamThread` target) and its ask card. The draft
 * streams into the reply; the files it found or was given come back as
 * `attachedFiles`, which the reply attaches through `inbox.replyAttachments`
 * (the server does not, for a team thread).
 *
 * Team threads have no catch-up summary (SPEC §7 "Team"): the left column is
 * the team stream with its open actions.
 *
 * "Draft with AI" needs the `ai` flag and the team inbox: the ask session and
 * its stream are read through `answerModeQuery`, which checks the target's own
 * flag, so a team-only instance has it too.
 */
import type { Id } from '@owlat/api/dataModel';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import { useAnswerAskSession, type AskSession } from '~/composables/useAnswerAskSession';

export function useAnswerTeamAssist(opts: {
	threadId: () => Id<'conversationThreads'> | null;
	composer: () => AnswerComposerApi | null;
	/** Attach a file the ask session found or was given. */
	attachFile: (file: AskSession['attachedFiles'][number]) => void;
}) {
	const { isEnabled } = useFeatureFlag();
	const aiEnabled = computed(() => isEnabled('ai'));
	const draftWithAi = computed(() => aiEnabled.value && isEnabled('inbox'));

	const ask = useAnswerAskSession({
		target: () => {
			const threadId = opts.threadId();
			return draftWithAi.value && threadId ? { kind: 'teamThread', threadId } : null;
		},
		composer: opts.composer,
		onAttachedFiles: (files) => {
			for (const file of files) opts.attachFile(file);
		},
	});

	return { aiEnabled, draftWithAi, ask };
}
