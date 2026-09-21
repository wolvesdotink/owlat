/**
 * Unit tests for `lib/decisionProviders/llm.ts` — the language-backed adapter
 * every keyless install runs on.
 *
 * Covers:
 *   - the GOLDEN prompt: all three question types, the optional Noul poles and
 *     a null Choice description, pinned byte for byte. Two adapters that word
 *     the same question differently answer it differently, and every later
 *     agreement/calibration number would be measuring that drift instead,
 *   - the rendered schema: an enum over the options, a whole level number, a
 *     probability in [0, 1],
 *   - answer mapping: degenerate probabilities, the Noul/confidence asymmetry,
 *     `calibrated: false` and the `llm-backed` provenance,
 *   - rejection rather than coercion for an out-of-domain, missing or extra
 *     answer,
 *   - cancellation: the caller's signal and the plane's own deadline both reach
 *     `runLlmObject`, and aborting one actually ends the call.
 *
 * The language plane is mocked at the dispatch seam: this file tests the
 * rendering and the mapping, not the AI SDK.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import { choice, noul, score } from '../../decision/questions';
import { DecisionWireError } from '../wire';

// Hoisted by vitest above the adapter import, so the module under test binds to
// the stub rather than the real (Node-only) AI SDK dispatch.
const runLlmObjectMock = vi.fn();

vi.mock('../../llm/dispatch', () => ({
	runLlmObject: (opts: unknown) => runLlmObjectMock(opts),
}));

// The real dispatch, reached with `importActual` in the last block below, so the
// abort widening this adapter depends on is proven and not assumed. Its own
// `generateObject` stays mocked: nothing here talks to a provider.
const generateObjectMock = vi.fn();

vi.mock('ai', async () => ({
	...(await vi.importActual('ai')),
	generateObject: (args: unknown) => generateObjectMock(args),
}));

import {
	llmDecisionAdapter,
	mapAnswers,
	renderDecisionPrompt,
	renderDecisionSchema,
	type LlmBackedDecisionRequest,
} from '../llm';

const fakeModel = { modelId: 'fake-model-id' } as unknown as LanguageModel;

const questions = {
	needsReply: noul('Does this message need a reply?', {
		true: 'A reply is expected',
		false: 'No reply is expected',
	}),
	spam: noul('Is this spam?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
	urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
};

const state = { subject: 'Invoice 42', body: 'Please pay by Friday.' };

/** What the model would return for {@link questions} under the rendered schema. */
const modelObject = { needsReply: 0.8, spam: 0.02, category: 'person', urgency: 2 };

function request(overrides: Partial<LlmBackedDecisionRequest> = {}): LlmBackedDecisionRequest {
	return { state, questions, model: fakeModel, ...overrides };
}

function lastDispatchArgs(): Record<string, unknown> {
	const calls = runLlmObjectMock.mock.calls;
	return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
	generateObjectMock.mockReset();
	runLlmObjectMock.mockReset();
	runLlmObjectMock.mockResolvedValue({
		object: modelObject,
		tokenUsage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 },
		modelUsed: 'fake-model-id',
	});
});

const GOLDEN_PROMPT = `Answer every question below about the state, using only what the state says.
Judge nothing that is not there, and write no commentary: the answers are the whole response.

## State

{
  "subject": "Invoice 42",
  "body": "Please pay by Friday."
}

## Questions

### needsReply — yes/no probability
Does this message need a reply?
true means: A reply is expected
false means: No reply is expected
Answer with the probability that this is true, from 0 (certainly false) to 1 (certainly true).

### spam — yes/no probability
Is this spam?
Answer with the probability that this is true, from 0 (certainly false) to 1 (certainly true).

### category — one label
Which category fits?
Options:
- person: A human wrote it
- newsletter
Answer with exactly one of the option labels above, copied verbatim.

### urgency — ordered score
How urgent is it?
Levels, lowest first:
1. Not urgent
2. This week
3. Immediately
Answer with the whole number 1 to 3 of the level that fits best.

Return one answer for every question key above, and no others.
`;

describe('renderDecisionPrompt()', () => {
	it('renders all three question types into the golden prompt', () => {
		expect(renderDecisionPrompt(state, questions)).toBe(GOLDEN_PROMPT);
	});

	it('is byte-identical across renders of an equivalent question set', () => {
		const rebuilt = {
			needsReply: noul('Does this message need a reply?', {
				true: 'A reply is expected',
				false: 'No reply is expected',
			}),
			spam: noul('Is this spam?'),
			category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
			urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
		};
		expect(renderDecisionPrompt(state, rebuilt)).toBe(renderDecisionPrompt(state, questions));
	});

	it('passes a string state through verbatim', () => {
		const rendered = renderDecisionPrompt('From: ana@example.com\nSubject: hi', {
			spam: noul('Is this spam?'),
		});
		expect(rendered).toContain('## State\n\nFrom: ana@example.com\nSubject: hi\n\n## Questions');
	});

	it('refuses an empty question set rather than billing a round trip for nothing', () => {
		expect(() => renderDecisionPrompt(state, {})).toThrow(DecisionWireError);
	});
});

describe('renderDecisionSchema()', () => {
	it('accepts an answer inside every question domain', () => {
		expect(renderDecisionSchema(questions).parse(modelObject)).toEqual(modelObject);
	});

	it('rejects a Choice outside the options, a Score off the scale and a Noul outside [0, 1]', () => {
		const schema = renderDecisionSchema(questions);
		expect(() => schema.parse({ ...modelObject, category: 'robot' })).toThrow();
		expect(() => schema.parse({ ...modelObject, urgency: 4 })).toThrow();
		expect(() => schema.parse({ ...modelObject, urgency: 1.5 })).toThrow();
		expect(() => schema.parse({ ...modelObject, needsReply: 1.4 })).toThrow();
	});
});

describe('mapAnswers()', () => {
	it('returns degenerate distributions, and no confidence on a Noul', () => {
		const answers = mapAnswers(questions, modelObject);
		expect(answers['needsReply']).toEqual({ kind: 'noul', probability: 0.8 });
		expect(answers['needsReply']).not.toHaveProperty('confidence');
		expect(answers['category']).toEqual({
			kind: 'choice',
			value: 'person',
			probabilities: { person: 1, newsletter: 0 },
			confidence: 1,
		});
		expect(answers['urgency']).toEqual({
			kind: 'score',
			value: 2,
			levels: ['Not urgent', 'This week', 'Immediately'],
			probabilities: { '1': 0, '2': 1, '3': 0 },
			confidence: 1,
		});
	});

	it('rejects an out-of-domain Choice rather than coercing it', () => {
		expect(() => mapAnswers(questions, { ...modelObject, category: 'robot' })).toThrow(
			DecisionWireError
		);
	});

	it('rejects a Score off its own scale and a Noul outside [0, 1]', () => {
		expect(() => mapAnswers(questions, { ...modelObject, urgency: 0 })).toThrow(DecisionWireError);
		expect(() => mapAnswers(questions, { ...modelObject, urgency: 2.5 })).toThrow(
			DecisionWireError
		);
		expect(() => mapAnswers(questions, { ...modelObject, needsReply: 1.2 })).toThrow(
			DecisionWireError
		);
	});

	it('rejects a missing answer and an answer to a question that was never asked', () => {
		const { urgency: _dropped, ...missing } = modelObject;
		expect(() => mapAnswers(questions, missing)).toThrow(/no answer for question 'urgency'/);
		expect(() => mapAnswers(questions, { ...modelObject, mood: 'sunny' })).toThrow(/not asked/);
	});

	it('truncates the value it echoes back', () => {
		const long = 'x'.repeat(200);
		expect(() => mapAnswers(questions, { ...modelObject, category: long })).toThrow(/…/);
	});
});

describe('llmDecisionAdapter.ask()', () => {
	it('dispatches the rendered prompt and schema at temperature zero', async () => {
		await llmDecisionAdapter.ask({}, request());
		const args = lastDispatchArgs();
		expect(args['model']).toBe(fakeModel);
		expect(args['prompt']).toBe(GOLDEN_PROMPT);
		expect(args['temperature']).toBe(0);
		expect(args['abortSignal']).toBeUndefined();
	});

	it('stamps the result llm-backed and never claims calibration', async () => {
		const result = await llmDecisionAdapter.ask({}, request());
		expect(result.calibrated).toBe(false);
		expect(result.provenance).toBe('llm-backed');
		expect(result.modelUsed).toBe('fake-model-id');
		expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 8, totalTokens: 128 });
		expect(result.answers['category']).toEqual({
			kind: 'choice',
			value: 'person',
			probabilities: { person: 1, newsletter: 0 },
			confidence: 1,
		});
	});

	it('falls back to zero usage and the requested model id when the plane reports neither', async () => {
		runLlmObjectMock.mockResolvedValueOnce({ object: modelObject });
		const result = await llmDecisionAdapter.ask({}, request());
		expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
		expect(result.modelUsed).toBe('fake-model-id');
	});

	it('rejects a response that disagrees with the question set', async () => {
		runLlmObjectMock.mockResolvedValueOnce({ object: { ...modelObject, category: 'robot' } });
		await expect(llmDecisionAdapter.ask({}, request())).rejects.toThrow(DecisionWireError);
	});

	it('needs the resolved language model on the request', async () => {
		const { model: _none, ...withoutModel } = request();
		await expect(llmDecisionAdapter.ask({}, withoutModel)).rejects.toThrow(
			/needs the resolved language model/
		);
		expect(runLlmObjectMock).not.toHaveBeenCalled();
	});

	it("carries the caller's abort signal into the language call, and cancels on it", async () => {
		runLlmObjectMock.mockImplementation(
			(opts: { abortSignal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal?.reason), {
						once: true,
					});
				})
		);
		const controller = new AbortController();
		const pending = llmDecisionAdapter.ask({}, request({ abortSignal: controller.signal }));
		expect(lastDispatchArgs()['abortSignal']).toBe(controller.signal);

		controller.abort(new Error('caller went away'));
		await expect(pending).rejects.toThrow('caller went away');
	});

	it("cancels on the plane's own deadline when one is set", async () => {
		runLlmObjectMock.mockImplementation(
			(opts: { abortSignal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					opts.abortSignal?.addEventListener('abort', () => reject(opts.abortSignal?.reason), {
						once: true,
					});
				})
		);
		const controller = new AbortController();
		const pending = llmDecisionAdapter.ask(
			{},
			request({ abortSignal: controller.signal, deadlineMs: 5 })
		);
		// Composed, not the caller's own: either handle must end the call.
		expect(lastDispatchArgs()['abortSignal']).not.toBe(controller.signal);
		await expect(pending).rejects.toThrow();
	});
});

describe('llmDecisionAdapter metadata', () => {
	it('is the uncalibrated, credential-free member of the registry', () => {
		expect(llmDecisionAdapter.kind).toBe('llm');
		expect(llmDecisionAdapter.calibrated).toBe(false);
		// The language plane owns the credential, so an install that entered no
		// decision key must still resolve.
		expect(() => llmDecisionAdapter.validateCredentials({})).not.toThrow();
	});
});

describe('the widened runLlmObject', () => {
	async function realDispatch(): Promise<typeof import('../../llm/dispatch')> {
		return await vi.importActual<typeof import('../../llm/dispatch')>('../../llm/dispatch');
	}

	it('hands the signal to the SDK, so a structured call is cancellable', async () => {
		const { runLlmObject } = await realDispatch();
		const controller = new AbortController();
		generateObjectMock.mockResolvedValueOnce({ object: { spam: 0.1 }, usage: {} });

		await runLlmObject({
			model: fakeModel,
			schema: renderDecisionSchema({ spam: noul('Is this spam?') }),
			prompt: 'p',
			abortSignal: controller.signal,
		});

		const args = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(args['abortSignal']).toBe(controller.signal);
	});

	it('refuses to dispatch at all once the signal is aborted', async () => {
		const { runLlmObject } = await realDispatch();
		const controller = new AbortController();
		controller.abort(new Error('caller went away'));

		await expect(
			runLlmObject({
				model: fakeModel,
				schema: renderDecisionSchema({ spam: noul('Is this spam?') }),
				prompt: 'p',
				abortSignal: controller.signal,
			})
		).rejects.toThrow('caller went away');
		expect(generateObjectMock).not.toHaveBeenCalled();
	});
});
