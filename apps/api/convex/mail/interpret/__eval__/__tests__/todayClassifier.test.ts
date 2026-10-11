/**
 * Today's classifiers as the eval's baseline executor: the Postbox heuristic
 * offline, today's own prompts and schemas through a mocked model call, and
 * the label domains kept equal to the ones production persists.
 */
import { describe, expect, it, vi } from 'vitest';
import { classificationSchema } from '../../../../agent/steps/classify';
import { LlmPartialUsageError } from '../../../../lib/llm/partialUsage';
import { estimateCost } from '../../../../lib/llm/pricing';
import { mailCategoryLabelValidator } from '../../../../lib/literalValidators';
import { POSTBOX_CATEGORIES, TEAM_CATEGORIES } from '../decisionLabels';
import { decisionInputFor } from '../decisionQuestions';
import {
	postboxTranscript,
	runTodayClassifier,
	teamContext,
	teamTriage,
	type TodayGenerate,
} from '../todayClassifier';
import { loadCorpus } from './corpusFixture';

const corpus = loadCorpus();
const thread = (id: string) => {
	const found = corpus.find((t) => t.id === id);
	if (!found) throw new Error(id);
	return found;
};

describe('label domains', () => {
	it('match the domains production persists', () => {
		expect([...POSTBOX_CATEGORIES].sort()).toEqual(
			mailCategoryLabelValidator.members.map((m) => m.value).sort()
		);
		expect([...TEAM_CATEGORIES].sort()).toEqual(
			[...classificationSchema.shape.category.options].sort()
		);
	});
});

describe('runTodayClassifier without a model', () => {
	it('runs the Postbox heuristic only, with no model call and no Team baseline', async () => {
		const run = await runTodayClassifier(corpus, { split: 'all' });
		expect(run.executor).toBe('today (heuristic only)');
		expect(run.rows).toEqual([]);
		expect(run.predictions.every((p) => p.task === 'postbox_category')).toBe(true);
		const brief = corpus.filter((t) => t.mode === 'brief');
		expect(run.predictions).toHaveLength(brief.reduce((n, t) => n + t.labels.decisions.length, 0));
		const value = (id: string) => run.predictions.find((p) => p.threadId === id)?.value;
		expect(value('list-001')).toBe('newsletter'); // List-Unsubscribe
		expect(value('auto-002')).toBe('notification'); // calendar-noreply@
		expect(value('spam-003')).toBe('promotion'); // "Exclusive offer" from a stranger
		expect(value('en-001')).toBe('person'); // a known correspondent
		expect(value('spam-001')).toBe('other'); // ambiguous: the fail-soft baseline
	});
});

describe('runTodayClassifier with a model', () => {
	const teamVerdict = {
		category: 'billing',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'request',
		confidence: 0.9,
		kind: 'personal',
		needsResponse: true,
		language: 'en',
		importance: 0.5,
	};

	it('asks today’s prompts and records one row per call under today’s features', async () => {
		const generate = vi.fn<TodayGenerate>(async ({ feature }) => ({
			object: feature === 'agent_classify' ? teamVerdict : { category: 'spam' },
			usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
			modelUsed: 'gpt-6-luna',
		}));
		const run = await runTodayClassifier(corpus, { split: 'heldout', generate, now: () => 0 });
		expect(run.executor).toBe('today (heuristic + model)');
		const prompts = generate.mock.calls.map(([request]) => request);
		const team = prompts.filter((r) => r.feature === 'agent_classify');
		const postbox = prompts.filter((r) => r.feature === 'postbox_category');
		expect(team.length).toBeGreaterThan(0);
		expect(postbox.length).toBeGreaterThan(0);
		expect(team[0]?.prompt).toContain('<untrusted_email_content>');
		expect(team[0]?.prompt).toContain('[CURRENT MESSAGE]');
		expect(team[0]?.temperature).toBe(0.2);
		expect(postbox[0]?.prompt).toContain('Classify this personal email into exactly one category');
		expect(postbox[0]?.temperature).toBe(0);
		expect(run.rows).toHaveLength(generate.mock.calls.length);
		expect(run.rows[0]).toMatchObject({
			plane: 'language',
			task: 'mail.classify',
			attempt: 1,
			modelUsed: 'gpt-6-luna',
			isEstimated: false,
		});
		expect(run.rows[0]?.rootRequestId).toMatch(/^eval\.today\.(team|postbox):/);
		// Team messages get all three Team tasks from one verdict.
		const teamPredictions = run.predictions.filter((p) =>
			corpus.find((t) => t.id === p.threadId && t.mode === 'actions')
		);
		const tasks = new Set(teamPredictions.map((p) => p.task));
		expect(tasks).toEqual(new Set(['team_category', 'disposition', 'triage']));
		expect(teamPredictions.find((p) => p.task === 'triage')?.value).toBe('needs_work');
	});

	it('keeps the `other` baseline when the refinement fails, and fails the Team tasks', async () => {
		const generate: TodayGenerate = async ({ feature }) => {
			if (feature === 'postbox_category') throw new Error('provider down');
			return { object: { category: 'nope' } };
		};
		const run = await runTodayClassifier(corpus, { split: 'heldout', generate });
		const refined = run.rows.filter((r) => r.feature === 'postbox_category');
		expect(refined.every((r) => r.isEstimated && r.costUsd === 0)).toBe(true);
		const postbox = run.predictions.filter((p) => p.task === 'postbox_category');
		expect(postbox.every((p) => p.outcome === 'answered')).toBe(true);
		// A bad Team answer was billed once and fails each task it would have fed.
		const teamRows = run.rows.filter((r) => r.feature === 'agent_classify');
		const failed = run.predictions.filter((p) => p.outcome === 'failed');
		expect(failed.length).toBe(teamRows.length * 3);
	});

	it('prices a failed call off the billed usage its error carries', async () => {
		const usage = { promptTokens: 2000, completionTokens: 80, totalTokens: 2080 };
		const generate: TodayGenerate = async () => {
			throw new LlmPartialUsageError(new Error('schema mismatch'), usage, 'gpt-6-luna');
		};
		const run = await runTodayClassifier(corpus, { split: 'heldout', generate });
		const priced = estimateCost('gpt-6-luna', usage);
		expect(run.rows.length).toBeGreaterThan(0);
		for (const row of run.rows) {
			expect(row).toMatchObject({
				...usage,
				modelUsed: 'gpt-6-luna',
				costUsd: priced.costUsd,
				isEstimated: priced.estimated,
			});
		}
	});
});

describe('today’s mapping and context', () => {
	it('derives triage the way the Team pipeline routes', () => {
		const verdict = classificationSchema.parse({
			category: 'support',
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'information',
			confidence: 0.9,
			kind: 'notification',
			needsResponse: false,
			language: 'en',
			importance: 0.2,
		});
		expect(teamTriage({ ...verdict, category: 'spam' }, 'informational')).toBe('spam');
		expect(teamTriage(verdict, 'informational')).toBe('automated');
		expect(teamTriage({ ...verdict, kind: 'personal' }, 'reply')).toBe('needs_work');
		expect(teamTriage({ ...verdict, kind: 'personal' }, 'informational')).toBe('no_work');
	});

	it('renders the history and the message the way the pipelines do', () => {
		const inputOf = (id: string) => {
			const t = thread(id);
			const label = t.labels.decisions[0];
			if (!label) throw new Error(id);
			return decisionInputFor(t, label);
		};
		const context = teamContext(inputOf('tin-015'));
		expect(context.indexOf('[CONVERSATION HISTORY]')).toBeLessThan(
			context.indexOf('[CURRENT MESSAGE]')
		);
		expect(context).toContain('Sure, the order number is 88213.');
		const parts = postboxTranscript(inputOf('en-002')).split('\n\n---\n\n');
		// Oldest first, the owner's own message labelled, the judged message last.
		expect(parts).toHaveLength(3);
		expect(parts[1]).toContain('— the mailbox owner (you)');
		expect(parts[2]).toMatch(/^From: Priya Nair <priya@example.org> — the other party/);
		expect(parts[2]).toContain('Thanks, looking forward to it.');
	});
});
