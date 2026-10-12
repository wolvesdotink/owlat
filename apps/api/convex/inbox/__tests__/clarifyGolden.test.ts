/**
 * Golden tests: with every routing switch at its default (`clarifyNecessity`
 * off), clarification on all three surfaces is what it was before the shared
 * service (ADR-0073, plan Phase 3, D5): the same model calls in the same order,
 * on the same tiers, with the same prompts, temperatures and ledger features,
 * and the same questions out.
 *
 * The golden files under `__golden__/` were recorded from the pre-service code
 * (the Team `clarify` step, the Postbox Reply Queue refinement and Answer
 * mode's gap check) and are compared verbatim. The ledger `task` is left out of
 * the log on purpose: samples now record under `mail.clarify_sample` (the
 * accounting change of this lane), asserted separately below.
 *
 * Every model call is mocked; nothing reaches a provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStepCtx } from '../../agent/steps/__tests__/stepCtx';
import type * as MeteredSpend from '../../analytics/meteredSpend';

interface CallLog {
	readonly calls: unknown[];
	readonly tasks: (string | undefined)[];
}

const mocks = vi.hoisted(() => ({
	log: { calls: [] as unknown[], tasks: [] as (string | undefined)[] },
	runLlmText: vi.fn(),
	runLlmObject: vi.fn(),
}));

vi.mock('../../lib/llm/dispatch', () => ({
	runLlmText: (opts: { model: unknown; prompt: string; temperature?: number }) => {
		mocks.log.calls.push({
			call: 'text',
			model: opts.model,
			temperature: opts.temperature,
			prompt: opts.prompt,
		});
		return mocks.runLlmText(opts);
	},
	runLlmObject: (opts: {
		model: unknown;
		prompt: string;
		temperature?: number;
		schema: unknown;
	}) => {
		mocks.log.calls.push({
			call: 'object',
			model: opts.model,
			temperature: opts.temperature,
			schema: schemaName(opts.schema),
			prompt: opts.prompt,
		});
		return mocks.runLlmObject(opts);
	},
}));
vi.mock('../../lib/llmProvider', () => ({
	resolveLanguageModel: vi.fn(async (_ctx: unknown, role: string) => `model:${role}`),
}));
vi.mock('../../analytics/meteredSpend', async () => {
	const actual = await vi.importActual<typeof MeteredSpend>('../../analytics/meteredSpend');
	return {
		...actual,
		meterLlmCall: async (
			ctx: object,
			target: { feature: string; task?: string; root?: { rootRequestId: string } },
			call: (meter: unknown) => Promise<unknown>,
			opts?: unknown
		) => {
			mocks.log.calls.push({
				call: 'meter',
				feature: target.feature,
				root: target.root ? rootPath(target.root.rootRequestId) : undefined,
				...(opts ? { opts } : {}),
			});
			mocks.log.tasks.push(target.task);
			return call(actual.meterFor(ctx, target as Parameters<typeof actual.meterFor>[1]));
		},
	};
});
vi.mock('../attachmentSuggest', () => ({ searchFilesForRequest: vi.fn(async () => []) }));

import { replySlotsSchema, divergenceSchema, type ReplySlot } from '../clarificationSlots';
import { clarifyStep, type ClarifyInput } from '../../agent/steps/clarify';
import { refineClarification } from '../../mail/ai/needsReplyRefine';
import { runGapCheck } from '../../mail/ai/composeDraftGap';
import type { Id } from '../../_generated/dataModel';

function schemaName(schema: unknown): string {
	if (schema === replySlotsSchema) return 'replySlots';
	if (schema === divergenceSchema) return 'divergence';
	return 'other';
}

/** A root id without its random part: `postbox_action:<random>` → `postbox_action`. */
function rootPath(rootRequestId: string): string {
	return rootRequestId.split(':')[0]!;
}

const slot = (over: Partial<ReplySlot>): ReplySlot => ({
	slotType: 'decision',
	question: 'Should we agree to push the launch date?',
	answerableFromContext: false,
	decisionRelevant: true,
	options: [],
	itemRef: null,
	...over,
});

const SLOTS: ReplySlot[] = [
	slot({}),
	slot({ slotType: 'price_number', question: 'What price should we quote?' }),
	slot({ slotType: 'date_time', question: 'Which date?', answerableFromContext: true }),
	slot({ slotType: 'attachment', question: 'Which contract should we send?' }),
	slot({ slotType: 'stance_tone', question: 'How firm?', decisionRelevant: false }),
];

const usage = (n: number) => ({ promptTokens: n, completionTokens: n, totalTokens: 2 * n });

/** The provider answers: slots, then samples, then the divergence verdict; translation fails soft. */
function answer(options: { divergent?: number[]; failedSamples?: number; judgeFails?: boolean }) {
	let samplesLeft = 3;
	let failures = options.failedSamples ?? 0;
	mocks.runLlmText.mockImplementation(async () => {
		samplesLeft -= 1;
		if (failures > 0) {
			failures -= 1;
			throw new Error('sample failed');
		}
		return {
			text: `Candidate reply ${samplesLeft}`,
			tokenUsage: usage(3),
			modelUsed: 'sample-model',
		};
	});
	mocks.runLlmObject.mockImplementation(async ({ schema }: { schema: unknown }) => {
		if (schema === replySlotsSchema) {
			return { object: { slots: SLOTS }, tokenUsage: usage(1), modelUsed: 'slot-model' };
		}
		if (schema === divergenceSchema) {
			if (options.judgeFails) throw new Error('judge failed');
			return {
				object: { divergentSlotIndexes: options.divergent ?? [] },
				tokenUsage: usage(5),
				modelUsed: 'judge-model',
			};
		}
		throw new Error('translation unavailable');
	});
}

afterEach(() => {
	vi.useRealTimers();
});

function logged(): CallLog {
	return { calls: [...mocks.log.calls], tasks: [...mocks.log.tasks] };
}

/** Memory answers are stamped with the time; the goldens were recorded at this one. */
const RECORDED_AT = Date.parse('2026-10-12T00:00:00Z');

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(RECORDED_AT);
	mocks.log.calls.length = 0;
	mocks.log.tasks.length = 0;
	mocks.runLlmText.mockReset();
	mocks.runLlmObject.mockReset();
});

// ── Team Inbox: the agent `clarify` step ──────────────────────────────────

const messageId = 'msg_golden_1' as Id<'inboundMessages'>;

function teamInput(category = 'support'): ClarifyInput {
	return {
		inboundMessageId: messageId,
		context: 'Customer: can we push the launch, and what would that cost? Send the contract.',
		classification: {
			category,
			priority: 'normal',
			sentiment: 'neutral',
			intent: 'question',
			confidence: 0.9,
		} as ClarifyInput['classification'],
	};
}

function teamCtx(fills: { questionId: string; value: string }[] = []) {
	const writes: unknown[] = [];
	const ctx = makeStepCtx<Parameters<typeof clarifyStep.execute>[0]>({
		queries: {
			getAskEagernessInternal: { mode: null },
			getMessage: { contextCoverage: { lowCoverage: true }, contactId: 'contact_golden' },
			routingContext: { policy: { clarifyNecessity: 'off', policyVersion: 0 } },
		},
		mutations: {
			recordClarificationAsk: (args) => {
				writes.push({ ask: args });
				return undefined;
			},
			resolveFills: (args) => {
				writes.push({ fills: args });
				return { fills };
			},
		},
	});
	return { ctx, writes };
}

describe('golden: Team clarify step, necessity off', () => {
	it('asks the divergent slots, with memory fills, as before', async () => {
		answer({ divergent: [1, 2] });
		const { ctx, writes } = teamCtx([{ questionId: 'clarify_2', value: 'Contract B' }]);
		const result = await clarifyStep.execute(ctx, teamInput());
		await expect({ result, writes, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/team-asks.golden'
		);
	});

	it('asks nothing when too few samples came back', async () => {
		answer({ failedSamples: 2 });
		const { ctx, writes } = teamCtx();
		const result = await clarifyStep.execute(ctx, teamInput());
		await expect({ result, writes, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/team-insufficient.golden'
		);
	});

	it('fails soft when the judgment fails', async () => {
		answer({ judgeFails: true });
		const { ctx, writes } = teamCtx();
		const result = await clarifyStep.execute(ctx, teamInput('complaint'));
		await expect({ result, writes, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/team-judge-fails.golden'
		);
	});
});

// ── Postbox: the Reply Queue refinement ───────────────────────────────────

const postboxCtx = () => {
	const queries: unknown[] = [];
	const ctx = {
		runQuery: vi.fn(async (_ref: unknown, args: unknown) => {
			queries.push(args);
			return { policy: { clarifyNecessity: 'off', policyVersion: 0 } };
		}),
		runMutation: vi.fn(async () => null),
		runAction: vi.fn(),
	};
	return ctx as never;
};

describe('golden: Postbox refinement, necessity off', () => {
	const opts = {
		transcript: 'Them: can you approve the refund and send the invoice?',
		fromAddress: 'ada@acme.test',
		root: { rootRequestId: 'postbox:msg_golden_2' },
	};

	it('asks the owed file and the divergent slots on the capable tier', async () => {
		answer({ divergent: [0] });
		const result = await refineClarification(postboxCtx(), opts);
		await expect({ result: { ...result, askedAt: 0 }, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/postbox-asks.golden'
		);
	});

	it('still asks for the file when the divergence stage fails', async () => {
		answer({ judgeFails: true });
		const result = await refineClarification(postboxCtx(), opts);
		await expect({ result: { ...result, askedAt: 0 }, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/postbox-judge-fails.golden'
		);
	});
});

// ── Answer mode: the gap check ────────────────────────────────────────────

function answerCtx() {
	return {
		runMutation: vi.fn(async () => ({ fills: [] })),
		runQuery: vi.fn(async () => ({ policy: { clarifyNecessity: 'off', policyVersion: 0 } })),
		runAction: vi.fn(),
	} as never;
}

describe('golden: Answer mode gap check, necessity off', () => {
	const input = {
		context: 'Them: can you approve the refund, and what price? Please send the contract.',
		triggerText: 'Please send the contract.',
		subject: 'Contract',
		counterpartAddress: 'ada@acme.test',
		locale: 'de',
	};

	it('samples on the cheap tier and judges on the capable tier', async () => {
		answer({ divergent: [0, 1] });
		const result = await runGapCheck(answerCtx(), input);
		await expect({ result, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/answer-default.golden'
		);
	});

	it('samples on the capable tier for the cautious dial', async () => {
		answer({ divergent: [1] });
		const result = await runGapCheck(answerCtx(), { ...input, eagerness: 'cautious' as const });
		await expect({ result, log: logged().calls }).toMatchFileSnapshot(
			'./__golden__/answer-cautious.golden'
		);
	});
});

// ── Accounting: samples are counted apart (task `mail.clarify_sample`) ─────

describe('sample accounting', () => {
	const SAMPLE = 'mail.clarify_sample';

	it('records each Team sample under the sample task, nothing else', async () => {
		answer({ divergent: [0] });
		await clarifyStep.execute(teamCtx().ctx, teamInput());
		// slots, three samples, the judge, the translation
		expect(logged().tasks).toEqual([undefined, SAMPLE, SAMPLE, SAMPLE, undefined, undefined]);
	});

	it('records each Postbox and Answer mode sample under the sample task', async () => {
		answer({ divergent: [0] });
		await refineClarification(postboxCtx(), {
			transcript: 'Them: can you approve it?',
			fromAddress: 'ada@acme.test',
		});
		expect(logged().tasks).toEqual([undefined, SAMPLE, SAMPLE, SAMPLE, undefined, undefined]);
		mocks.log.tasks.length = 0;
		answer({ divergent: [0] });
		await runGapCheck(answerCtx(), {
			context: 'Them: can you approve it?',
			triggerText: 'Can you approve it?',
			subject: 'Approval',
			locale: 'de',
		});
		expect(logged().tasks).toEqual([undefined, SAMPLE, SAMPLE, SAMPLE, undefined, undefined]);
	});
});
