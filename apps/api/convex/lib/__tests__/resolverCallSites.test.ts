/**
 * Route equivalence, call site by call site (ADR-0073, plan Phase 4). Before
 * the task-policy catalog, each call site picked its model with a seven-value
 * `LLMTask` that mapped to a tier (`draft` and `plan` capable, the rest fast).
 * Now each names its catalog task and the resolver takes the tier from the
 * catalog (`lib/llm/taskRouting.ts`).
 *
 * This test pins EVERY resolver call in the backend, with the `LLMTask` it
 * passed before, and proves the catalog resolves the same tier for it: the
 * same model, byte for byte, since the tier-to-model step is unchanged. A new
 * call site, or a changed one, fails here until it is added with its reason.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_TASK_NAMES, type AiTaskName } from '@owlat/shared/aiRouting';
import { TASK_POLICIES } from '../llm/taskPolicy';
import { taskTier, userTextTier, type LlmTier } from '../llm/taskRouting';
import { isTrivialUserText } from '../llm/complexity';

const convexRoot = join(import.meta.dirname, '..', '..');

/** The resolver before the catalog: `taskTier` of `lib/llmProvider.ts` on 2026-10-11. */
type LegacyTask = 'classify' | 'extract' | 'guard' | 'summarize' | 'suggest' | 'draft' | 'plan';
function legacyTier(task: LegacyTask): LlmTier {
	return task === 'draft' || task === 'plan' ? 'capable' : 'fast';
}

/** What a call site passes now, and what it passed before, per tier branch. */
interface CallSite {
	readonly file: string;
	readonly fn:
		| 'resolveLanguageModel'
		| 'resolveLanguageModelWithProvenance'
		| 'resolveLanguageModelForUserText';
	/** The call's argument text, whitespace collapsed. */
	readonly args: string;
	/** The catalog task(s) the call resolves for. */
	readonly tasks: readonly AiTaskName[];
	/**
	 * The tier choice each branch of the call passes (`undefined`: none, the
	 * task's usual tier), with the `LLMTask` that branch passed before. The
	 * draft step's `fast` branch was `resolveLanguageModelForClassifiedDraft`'s
	 * downgrade (`LLM_COMPLEXITY_ROUTING`), pinned by `llmProvider.test.ts`.
	 */
	readonly branches: ReadonlyArray<readonly [LlmTier | undefined, LegacyTask]>;
}

const DECISION_TASKS = AI_TASK_NAMES.filter((task) => TASK_POLICIES[task].plane === 'decision');

const site = (
	file: string,
	args: string,
	legacy: LegacyTask,
	fn: CallSite['fn'] = 'resolveLanguageModel'
): CallSite => {
	const task = /'([a-z_.]+)'/.exec(args)?.[1] as AiTaskName;
	return { file, fn, args, tasks: [task], branches: [[undefined, legacy]] };
};

const INVENTORY: readonly CallSite[] = [
	site('quickQuery.ts', "ctx, 'assistant.quick_query'", 'draft'),
	site('visualizationAgentActions.ts', "ctx, 'analytics.visualize'", 'draft'),
	site('visualizationAgentActions.ts', "ctx, 'analytics.visualize_title'", 'summarize'),
	site('translate.ts', "ctx, 'mail.translate'", 'summarize'),
	site(
		'assistant/runner.ts',
		"ctx, 'assistant.answer', opts.lastUserText",
		'draft',
		'resolveLanguageModelForUserText'
	),
	site(
		'assistant/tools.ts',
		"ctx, 'assistant.tool_draft', intent",
		'draft',
		'resolveLanguageModelForUserText'
	),
	site(
		'assistant/tools.ts',
		"ctx, 'assistant.tool_draft', brief",
		'draft',
		'resolveLanguageModelForUserText'
	),
	// The decision plane's language-backed adapter and its fallback hop: the decision task asked.
	{
		file: 'lib/decisionProvider.ts',
		fn: 'resolveLanguageModel',
		args: 'ctx, task',
		tasks: DECISION_TASKS,
		branches: [[undefined, 'classify']],
	},
	{
		file: 'lib/decisionProvider.ts',
		fn: 'resolveLanguageModel',
		args: 'ctx, task',
		tasks: DECISION_TASKS,
		branches: [[undefined, 'classify']],
	},
	site('lib/semanticFileAi.ts', "ctx, 'file.summarize'", 'summarize'),
	{
		file: 'plugins/llm.ts',
		fn: 'resolveLanguageModelWithProvenance',
		args: "ctx, 'plugin.invoke', { tier: request.tier }",
		tasks: ['plugin.invoke'],
		branches: [
			['fast', 'summarize'],
			['capable', 'draft'],
		],
	},
	site('knowledge/edgeInference.ts', "ctx, 'knowledge.relate'", 'extract'),
	site('knowledge/extraction.ts', "ctx, 'knowledge.extract'", 'extract'),
	site('knowledge/extraction.ts', "ctx, 'knowledge.extract'", 'extract'),
	site('knowledge/extraction.ts', "ctx, 'knowledge.extract'", 'extract'),
	site('agent/outcomeFeedback.ts', "ctx, 'mail.outcome_sentiment'", 'classify'),
	site('agent/shared/draftSelfCheck.ts', "ctx, 'mail.draft_check'", 'classify'),
	// NEW, only behind the policy's `cheapFirstWriter`: the cheap-first path's
	// checks, resolved up front to price its hold, on the self-check's tier.
	{
		file: 'agent/shared/cheapFirstDraft.ts',
		fn: 'resolveLanguageModel',
		args: 'ctx, CHECK_TASK',
		tasks: ['mail.draft_check'],
		branches: [[undefined, 'classify']],
	},
	// The draft step's writer (./agent/steps/draft/writerRoute.ts). `capable`
	// is today's route; `fast` was `resolveLanguageModelForClassifiedDraft`'s
	// downgrade (`LLM_COMPLEXITY_ROUTING`), and is also the cheap-first pass.
	{
		file: 'agent/steps/draft/index.ts',
		fn: 'resolveLanguageModel',
		args: "ctx, 'mail.draft', { tier: route === 'capable' ? 'capable' : 'fast' }",
		tasks: ['mail.draft'],
		branches: [
			['capable', 'draft'],
			['fast', 'summarize'],
		],
	},
	// NEW, only behind the policy's `cheapFirstWriter`: the cheap-first
	// escalation, on today's capable draft tier.
	{
		file: 'agent/steps/draft/index.ts',
		fn: 'resolveLanguageModel',
		args: "ctx, 'mail.draft', { tier: 'capable' }",
		tasks: ['mail.draft'],
		branches: [['capable', 'draft']],
	},
	site('agent/steps/clarify/index.ts', "ctx, 'mail.clarify'", 'classify'),
	site('agent/steps/security_scan/guard.ts', "ctx, 'mail.guard'", 'guard'),
	site('agent/steps/classify/index.ts', "ctx, 'mail.classify'", 'classify'),
	// The language rung of a decision bundle: the bundle's decision task.
	{
		file: 'decision/bundleRunner.ts',
		fn: 'resolveLanguageModel',
		args: 'ctx, run.plan.task',
		tasks: DECISION_TASKS,
		branches: [[undefined, 'classify']],
	},
	site('mail/handlingRulesCompile.ts', "ctx, 'mail.rule_compile'", 'classify'),
	site('mail/replyOptions.ts', "ctx, 'mail.suggest'", 'suggest'),
	site('mail/interpret/coverage.ts', "ctx, 'mail.plan_coverage'", 'summarize'),
	site('mail/interpret/verify.ts', "ctx, 'mail.verify'", 'guard'),
	site('mail/interpret/extractOutput.ts', "ctx, 'mail.extract'", 'extract'),
	site('mail/interpret/run.ts', "ctx, 'mail.verify'", 'guard'),
	site(
		'mail/ai/reviseDraft.ts',
		"ctx, 'mail.compose', args.instruction",
		'draft',
		'resolveLanguageModelForUserText'
	),
	site('mail/ai/draftOnArrival.ts', "ctx, 'mail.draft'", 'draft'),
	site('mail/ai/composeDraftGap.ts', "ctx, 'mail.clarify'", 'summarize'),
	{
		file: 'mail/ai/composeDraftGap.ts',
		fn: 'resolveLanguageModel',
		args: "ctx, 'mail.clarify', { tier: eagerness === 'cautious' ? 'capable' : 'fast' }",
		tasks: ['mail.clarify'],
		branches: [
			['capable', 'draft'],
			['fast', 'summarize'],
		],
	},
	{
		file: 'mail/ai/composeDraftGap.ts',
		fn: 'resolveLanguageModel',
		args: "ctx, 'mail.clarify', { tier: 'capable' }",
		tasks: ['mail.clarify'],
		branches: [['capable', 'draft']],
	},
	site('mail/ai/composeDraftGap.ts', "ctx, 'mail.clarify'", 'summarize'),
	site('mail/ai/commitmentExtract.ts', "ctx, 'mail.extract'", 'summarize'),
	site('mail/ai/voiceProfileActions.ts', "ctx, 'mail.voice_profile'", 'extract'),
	...[0, 1].map((): CallSite => ({
		file: 'mail/ai/needsReplyDivergence.ts',
		fn: 'resolveLanguageModel',
		args: "ctx, 'mail.clarify', { tier: 'capable' }",
		tasks: ['mail.clarify'],
		branches: [['capable', 'draft']],
	})),
	site('mail/ai/composeDraftWrite.ts', "ctx, 'mail.compose'", 'draft'),
	site('mail/ai/coach.ts', "ctx, 'mail.coach'", 'classify'),
	site('mail/ai/categoryClassify.ts', "ctx, 'mail.classify'", 'summarize'),
	site('mail/ai/needsReplyClassify.ts', "ctx, 'mail.clarify'", 'summarize'),
	site('mail/ai/needsReplyClassify.ts', "ctx, 'mail.clarify'", 'summarize'),
	site('mail/ai/assist.ts', "ctx, 'mail.ask'", 'draft'),
	site('mail/ai/assist.ts', "ctx, 'mail.complete'", 'summarize'),
	site(
		'mail/ai/assist.ts',
		"ctx, 'mail.rewrite', args.selection",
		'draft',
		'resolveLanguageModelForUserText'
	),
	site('mail/ai/needsReplyDraft.ts', "ctx, 'mail.draft'", 'draft'),
	site('mail/ai/needsReplyDraft.ts', "ctx, 'mail.draft'", 'draft'),
];

function sources(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!['_generated', '__tests__', 'node_modules'].includes(name)) sources(path, out);
		} else if (
			name.endsWith('.ts') &&
			!name.endsWith('.test.ts') &&
			!name.endsWith('.testlib.ts')
		) {
			out.set(normalize(relative(convexRoot, path)), readFileSync(path, 'utf8'));
		}
	}
	return out;
}

const CALL = /\b(resolveLanguageModel(?:WithProvenance|ForUserText)?)\(/g;

/** Every resolver call outside the resolver itself: file, function, argument text. */
function scannedCalls(): string[] {
	const calls: string[] = [];
	for (const [file, text] of sources(convexRoot)) {
		if (file === 'lib/llmProvider.ts') continue;
		for (const match of text.matchAll(CALL)) {
			if (/function\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
			let depth = 1;
			let end = match.index + match[0].length;
			for (; depth > 0; end++) {
				if (text[end] === '(') depth++;
				else if (text[end] === ')') depth--;
			}
			const args = text
				.slice(match.index + match[0].length, end - 1)
				.replace(/\s+/g, ' ')
				// The formatter's trailing commas are layout, not arguments.
				.replace(/,\s*([}\]])/g, ' $1')
				.trim();
			calls.push(`${file} | ${match[1]} | ${args}`);
		}
	}
	return calls.sort();
}

describe('resolver call sites (route equivalence)', () => {
	it('pins every resolver call in the backend', () => {
		const pinned = INVENTORY.map((call) => `${call.file} | ${call.fn} | ${call.args}`).sort();
		expect(scannedCalls()).toEqual(pinned);
	});

	it.each(INVENTORY.map((call, index) => [`${call.file} #${index}: ${call.args}`, call] as const))(
		'%s resolves the tier it resolved before the catalog',
		(_label, call) => {
			for (const task of call.tasks) {
				for (const [choice, legacy] of call.branches) {
					const expected = legacyTier(legacy);
					if (call.fn === 'resolveLanguageModelForUserText') {
						// Routing off: the usual tier. Routing on: trivial owner text
						// downgrades exactly when the old capable-tier rule did.
						expect(userTextTier(task, 'Explain why the totals differ, step by step.', false)).toBe(
							expected
						);
						expect(userTextTier(task, 'thanks!', false)).toBe(expected);
						const legacyOn =
							expected === 'capable' && isTrivialUserText('thanks!') ? 'fast' : expected;
						expect(userTextTier(task, 'thanks!', true)).toBe(legacyOn);
						expect(userTextTier(task, 'Explain why the totals differ, step by step.', true)).toBe(
							expected
						);
					} else {
						expect(taskTier(task, choice === undefined ? {} : { tier: choice })).toBe(expected);
					}
				}
			}
		}
	);
});
