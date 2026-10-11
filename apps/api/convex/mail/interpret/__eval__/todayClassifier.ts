'use node';

/**
 * Today's classifiers as an eval executor, so the decision report can state
 * baseline accuracy and agreement against the routes that run now:
 *
 *   - Postbox category (`brief` threads): the deterministic heuristic
 *     (`mail/category.ts` `classifyMailCategory`), and for mail it leaves
 *     ambiguous, the cheap-tier refinement prompt (`mail/ai/categoryClassify.ts`)
 *     when a model call is injected, else the persisted fail-soft `other`.
 *   - Team Inbox (`actions` threads): the `classify` step's prompt and schema
 *     (`agent/steps/classify`), mapped onto the eval's tasks exactly as the
 *     pipeline reads them: `category` as the Team category, the routed
 *     disposition (`resolveResponseDisposition`, spam archived without a reply)
 *     and a triage derived from category, kind and disposition. Without an
 *     injected model call the Team baseline does not run.
 *
 * The model call is injected (`TodayGenerate`) like `liveModel.ts`; tests pass
 * a mock and the CLI an AI SDK call. The context is built from the replay's
 * sanitized view, so it lacks what retrieval adds in production (contacts,
 * knowledge, files): agreement measured here is on the message itself.
 *
 * `'use node'` because the classify step module is.
 */
import type { z } from 'zod';
import type { TokenUsage } from '../../../agent/steps/types';
import {
	buildClassifyPrompt,
	classificationSchema,
	resolveResponseDisposition,
} from '../../../agent/steps/classify';
import { BULK_KINDS } from '../../../lib/validators/classification';
import { estimateCost } from '../../../lib/llm/pricing';
import { buildCategoryPrompt, categoryRefinementSchema } from '../../ai/categoryClassify';
import { CATEGORY } from '../../ai/transcript';
import { classifyMailCategory } from '../../category';
import type { EvalThread } from './corpus';
import type { EvalSplit, TriageClass } from './decisionLabels';
import { bodyText, decisionInputFor, type DecisionEvalInput } from './decisionQuestions';
import {
	errorText,
	evalRootRequestId,
	type DecisionPrediction,
	type DecisionRun,
} from './decisionRunner';
import type { EvalModelMessage } from './replay';
import { threadsInSplit } from './splits';

/** One structured model call, as `runLlmObject` makes it. */
export type TodayGenerate = (request: {
	prompt: string;
	schema: z.ZodTypeAny;
	temperature: number;
	/** The ledger feature today's call records under. */
	feature: 'agent_classify' | 'postbox_category';
}) => Promise<{ object: unknown; usage?: TokenUsage; modelUsed?: string }>;

const party = (p: { name?: string; email: string }) =>
	p.name ? `${p.name} <${p.email}>` : p.email;

/** The Postbox transcript shape (`buildThreadTranscript`) within the CATEGORY budget. */
export function postboxTranscript(input: DecisionEvalInput): string {
	const owner = new Set(input.us);
	const render = (m: EvalModelMessage) => {
		const side = owner.has(m.from.email.toLowerCase())
			? ' — the mailbox owner (you)'
			: ' — the other party';
		return `From: ${party(m.from)}${side}\nSubject: ${m.subject}\n${bodyText(m, CATEGORY.perMessageChars)}`;
	};
	const parts = [...input.history.map(render), render(input.message)];
	let transcript = parts.join('\n\n---\n\n');
	while (transcript.length > CATEGORY.totalChars && parts.length > 1) {
		parts.shift();
		transcript = parts.join('\n\n---\n\n');
	}
	return transcript.slice(0, CATEGORY.totalChars);
}

/** The Team briefing's history and current-message sections (`context_retrieval`). */
export function teamContext(input: DecisionEvalInput): string {
	const sections: string[] = [];
	if (input.history.length > 0) {
		const lines = input.history.map(
			(m) =>
				`From: ${m.from.email}\nDate: ${new Date(m.sentAt).toISOString()}\nSubject: ${m.subject}\n${bodyText(m)}\n---`
		);
		sections.push(`[CONVERSATION HISTORY]\n${lines.join('\n')}`);
	}
	const m = input.message;
	sections.push(
		'[CURRENT MESSAGE]\n' +
			`From: ${m.from.email}\n` +
			`To: ${m.to.map((p) => p.email).join(', ')}\n` +
			`Subject: ${m.subject}\n` +
			`Date: ${new Date(m.sentAt).toISOString()}\n` +
			`Body:\n${bodyText(m)}`
	);
	return sections.join('\n\n');
}

type TeamVerdict = z.infer<typeof classificationSchema>;

/** The triage today's Team pipeline implies: spam archived, bulk kinds automated, then disposition. */
export function teamTriage(verdict: TeamVerdict, disposition: string): TriageClass {
	if (verdict.category === 'spam') return 'spam';
	if (BULK_KINDS.has(verdict.kind)) return 'automated';
	return disposition === 'reply' ? 'needs_work' : 'no_work';
}

export interface TodayRunOptions {
	split: EvalSplit | 'all';
	/** The model call; absent ⇒ Postbox heuristic only, no Team baseline. */
	generate?: TodayGenerate;
	now?: () => number;
}

/** Run today's classifiers over every labelled message of the split. */
export async function runTodayClassifier(
	corpus: readonly EvalThread[],
	options: TodayRunOptions
): Promise<DecisionRun> {
	const { generate } = options;
	const now = options.now ?? Date.now;
	const run: DecisionRun = {
		executor: generate ? 'today (heuristic + model)' : 'today (heuristic only)',
		split: options.split,
		predictions: [],
		rows: [],
	};

	/** One model call and its ledger row; the error text when it threw or did not parse. */
	const call = async <T>(
		input: DecisionEvalInput,
		request: Parameters<TodayGenerate>[0],
		parse: (object: unknown) => T
	): Promise<{ value: T } | { error: string }> => {
		if (!generate) return { error: 'no model configured' };
		const rootRequestId = evalRootRequestId('today', input);
		const started = now();
		const base = {
			feature: request.feature,
			plane: 'language' as const,
			rootRequestId,
			requestId: `${rootRequestId}#classify`,
			task: 'mail.classify',
			attempt: 1,
		};
		let response: Awaited<ReturnType<TodayGenerate>>;
		try {
			response = await generate(request);
		} catch (caught) {
			run.rows.push({
				...base,
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				costUsd: 0,
				isEstimated: true,
				latencyMs: now() - started,
			});
			return { error: errorText(caught) };
		}
		const { object, usage, modelUsed } = response;
		const cost = estimateCost(modelUsed, usage);
		run.rows.push({
			...base,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			totalTokens: usage?.totalTokens ?? 0,
			...(modelUsed ? { modelUsed } : {}),
			costUsd: cost.costUsd,
			isEstimated: cost.estimated,
			latencyMs: now() - started,
		});
		// A billed answer that does not parse is one row and a failed prediction.
		try {
			return { value: parse(object) };
		} catch (caught) {
			return { error: errorText(caught) };
		}
	};

	const push = (
		input: DecisionEvalInput,
		task: DecisionPrediction['task'],
		result: { value: string } | { error: string }
	) =>
		run.predictions.push({
			task,
			threadId: input.threadId,
			messageId: input.messageId,
			locale: input.locale,
			...('value' in result
				? { outcome: 'answered' as const, value: result.value }
				: { outcome: 'failed' as const, error: result.error }),
		});

	for (const thread of threadsInSplit(corpus, options.split)) {
		for (const label of thread.labels.decisions) {
			const input = decisionInputFor(thread, label);
			if (thread.mode === 'brief') {
				const headers = thread.messages.find((m) => m.id === label.messageId)?.headers;
				const heuristic = classifyMailCategory({
					fromAddress: input.message.from.email,
					subject: input.message.subject,
					hasListUnsubscribe: !!headers?.listUnsubscribe,
					precedence: headers?.precedence,
					isKnownCorrespondent: input.senderKnown,
				});
				if (heuristic !== null || !generate) {
					// The heuristic's label, or the `other` baseline the action persists
					// before it tries the model.
					push(input, 'postbox_category', { value: heuristic ?? 'other' });
					continue;
				}
				const refined = await call(
					input,
					{
						prompt: buildCategoryPrompt(postboxTranscript(input)),
						schema: categoryRefinementSchema,
						temperature: 0,
						feature: 'postbox_category',
					},
					(object) => categoryRefinementSchema.parse(object).category
				);
				// A failed refinement leaves the persisted `other` baseline in place.
				push(input, 'postbox_category', 'value' in refined ? refined : { value: 'other' });
				continue;
			}
			if (!generate) continue;
			const verdict = await call(
				input,
				{
					prompt: buildClassifyPrompt(teamContext(input)),
					schema: classificationSchema,
					temperature: 0.2,
					feature: 'agent_classify',
				},
				(object) => classificationSchema.parse(object)
			);
			if (!('value' in verdict)) {
				for (const task of ['team_category', 'disposition', 'triage'] as const) {
					push(input, task, verdict);
				}
				continue;
			}
			const v = verdict.value;
			const disposition = v.category === 'spam' ? 'informational' : resolveResponseDisposition(v);
			push(input, 'team_category', { value: v.category });
			push(input, 'disposition', { value: disposition });
			push(input, 'triage', { value: teamTriage(v, disposition) });
		}
	}
	return run;
}
