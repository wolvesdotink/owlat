/**
 * The answers a background clarification (the Postbox Reply Queue, the team
 * agent) takes, from what the ask card emits.
 *
 * The ask card leaves out a remembered answer the person kept as it was ("Draft
 * with AI" already holds it on its session). The background mutations do not:
 * the team one resumes the agent's draft only once every question is answered,
 * and both record which answers came from memory so a replayed fact is not
 * captured again as the person's own. So a kept memory answer goes back with
 * `source: 'memory'`; everything the person answered is `source: 'user'`.
 */
export interface BackgroundAskQuestion {
	id: string;
	answer?: { value: string; source?: 'user' | 'memory' } | undefined;
}

export interface EmittedAskAnswer {
	questionId: string;
	value?: string;
	file?: { source: 'upload' | 'semanticFile' | 'mailAttachment'; id: string; filename: string };
	files?: { source: 'upload' | 'semanticFile' | 'mailAttachment'; id: string; filename: string }[];
	keepCopy?: boolean;
}

export type BackgroundAskAnswer = EmittedAskAnswer & { source: 'user' | 'memory' };

export function backgroundAskAnswers(
	questions: readonly BackgroundAskQuestion[],
	emitted: readonly EmittedAskAnswer[]
): BackgroundAskAnswer[] {
	const answered = new Set(emitted.map((a) => a.questionId));
	const kept = questions.flatMap((q): BackgroundAskAnswer[] =>
		!answered.has(q.id) && q.answer?.source === 'memory'
			? [{ questionId: q.id, value: q.answer.value, source: 'memory' }]
			: []
	);
	return [...emitted.map((a) => ({ ...a, source: 'user' as const })), ...kept];
}
