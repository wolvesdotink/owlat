/**
 * `recallKnowledge` draft-tool tests.
 *
 * Covers:
 *   - returns contact-scoped facts through the SAME isolation gate the context
 *     step uses (scopeToContact is threaded verbatim into semanticSearch, never
 *     org-wide), with untrusted text scrubbed + clamped.
 *   - is BOUNDED: after MAX_RECALL_CALLS live retrievals, further calls return an
 *     empty, instructive result and issue NO more retrievals.
 *   - FAILS SOFT: a retrieval error yields an empty fact list, never throwing.
 *   - the draft step wires the tool so a model that calls it triggers a recall
 *     (the dispatch seam is mocked to invoke the tool).
 *
 * The Convex action seam + the LLM dispatch/provider seams are mocked — no live
 * backend or model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';
import type { Id } from '../../../../_generated/dataModel';

const contactId = 'contact_1' as Id<'contacts'>;

// ── recall tool, in isolation ────────────────────────────────────────────────

import { buildRecallKnowledgeTool, MAX_RECALL_CALLS, RECALL_RESULT_LIMIT } from '../recall';

type RunAction = (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;

function toolExecute(tool: unknown, input: { query: string }): Promise<unknown> {
	// AI SDK tool exposes `.execute`; call it directly for the unit test.
	const t = tool as { execute: (i: { query: string }, o: unknown) => Promise<unknown> };
	return t.execute(input, {});
}

describe('buildRecallKnowledgeTool', () => {
	it('returns contact-scoped facts through the same isolation gate', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const runAction: RunAction = async (ref, args) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			expect(name).toContain('semanticSearch');
			calls.push(args);
			return [
				{
					title: 'Refund policy',
					entryType: 'fact',
					confidence: 0.9,
					content: 'Refund in 14 days.',
					_stale: false,
				},
			];
		};
		const tool = buildRecallKnowledgeTool({
			runAction: runAction as never,
			scopeToContact: contactId,
		});

		const result = (await toolExecute(tool, { query: 'refund window' })) as {
			facts: Array<{ title: string; content: string }>;
		};

		// Scoped verbatim to the contact — never org-wide.
		expect(calls[0]!['scopeToContact']).toBe(contactId);
		expect(calls[0]!['limit']).toBe(RECALL_RESULT_LIMIT);
		expect(calls[0]!['expandGraph']).toBe(false);
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0]!.title).toBe('Refund policy');
	});

	it('falls closed to org-general-only when there is no resolved contact', async () => {
		const calls: Array<Record<string, unknown>> = [];
		const runAction: RunAction = async (_ref, args) => {
			calls.push(args);
			return [];
		};
		const tool = buildRecallKnowledgeTool({
			runAction: runAction as never,
			scopeToContact: 'org-general-only',
		});
		await toolExecute(tool, { query: 'anything' });
		expect(calls[0]!['scopeToContact']).toBe('org-general-only');
	});

	it('is bounded: stops retrieving after MAX_RECALL_CALLS', async () => {
		let retrievals = 0;
		const runAction: RunAction = async () => {
			retrievals++;
			return [];
		};
		const tool = buildRecallKnowledgeTool({
			runAction: runAction as never,
			scopeToContact: contactId,
		});

		// Exhaust the budget, then call once more.
		for (let i = 0; i < MAX_RECALL_CALLS; i++) {
			await toolExecute(tool, { query: `q${i}` });
		}
		const over = (await toolExecute(tool, { query: 'one too many' })) as {
			facts: unknown[];
			note?: string;
		};

		// No retrieval beyond the cap; the over-limit call returns an empty,
		// instructive result instead of hitting the backend.
		expect(retrievals).toBe(MAX_RECALL_CALLS);
		expect(over.facts).toEqual([]);
		expect(over.note).toBeTruthy();
	});

	it('fails soft: a retrieval error yields an empty fact list, never throws', async () => {
		const runAction: RunAction = async () => {
			throw new Error('retrieval boom');
		};
		const tool = buildRecallKnowledgeTool({
			runAction: runAction as never,
			scopeToContact: contactId,
		});
		const result = (await toolExecute(tool, { query: 'anything' })) as { facts: unknown[] };
		expect(result.facts).toEqual([]);
	});
});

// ── draft step wires the tool so a model call triggers a recall ──────────────

const mocks = vi.hoisted(() => ({
	runLlmTextWithTools: vi.fn(),
	runLlmObject: vi.fn(),
	resolveLanguageModel: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmText: mocks.runLlmTextWithTools,
	runLlmTextWithTools: mocks.runLlmTextWithTools,
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	resolveLanguageModel: mocks.resolveLanguageModel,
	resolveLanguageModelForClassifiedDraft: mocks.resolveLanguageModel,
}));

import { draftStep, type DraftInput } from '../index';

const messageId = 'msg_1' as Id<'inboundMessages'>;
const draftInput: DraftInput = {
	inboundMessageId: messageId,
	context: 'Customer asks: what is the refund window?',
	classification: {
		category: 'support',
		priority: 'normal',
		sentiment: 'neutral',
		intent: 'question',
		confidence: 0.95,
	},
};

describe('draftStep.execute — recall wiring', () => {
	beforeEach(() => {
		mocks.runLlmTextWithTools.mockReset();
		mocks.runLlmObject.mockReset();
		mocks.resolveLanguageModel.mockReset();
		mocks.resolveLanguageModel.mockReturnValue('mock-model');
		mocks.runLlmObject.mockResolvedValue({
			object: { score: 0.9, complete: true, grounded: true, flags: [] },
			tokenUsage: undefined,
			modelUsed: 'mock-model',
		});
	});

	it('a draft needing an un-retrieved fact triggers a recall', async () => {
		let recalled = false;
		const recalledFacts = [
			{
				title: 'Refund policy',
				entryType: 'fact',
				confidence: 0.9,
				content: 'Refund in 14 days.',
				_stale: false,
			},
		];

		// The mocked model "decides" it needs a fact and calls the tool once,
		// then produces a grounded draft.
		mocks.runLlmTextWithTools.mockImplementation(
			async (opts: { tools: { recallKnowledge: unknown } }) => {
				await toolExecute(opts.tools.recallKnowledge, { query: 'refund window' });
				return {
					text: 'Our refund window is 14 days.',
					tokenUsage: undefined,
					modelUsed: 'mock-model',
				};
			}
		);

		const ctx = {
			runQuery: async (ref: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('getAgentConfig')) return null;
				if (name.includes('getMessage')) return { subject: 'Refund?', contactId };
				throw new Error(`unexpected runQuery: ${name}`);
			},
			runAction: async (ref: unknown, args: Record<string, unknown>) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('semanticSearch')) {
					recalled = true;
					expect(args['scopeToContact']).toBe(contactId);
					return recalledFacts;
				}
				throw new Error(`unexpected runAction: ${name}`);
			},
			runMutation: async (ref: unknown) => {
				const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
				if (name.includes('recordDraftOutput')) return undefined;
				if (name.includes('llmUsage')) return undefined;
				throw new Error(`unexpected runMutation: ${name}`);
			},
		} as unknown as Parameters<typeof draftStep.execute>[0];

		const { output } = await draftStep.execute(ctx, draftInput);

		expect(recalled).toBe(true);
		expect(output.draftResponse).toBe('Our refund window is 14 days.');
	});
});
