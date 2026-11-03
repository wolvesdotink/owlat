/**
 * The `rewriteSearch` action around the pure contract: a query that already uses
 * operators costs nothing, a plain one passes the AI gate before the model is
 * called, its spend lands under its own feature tag, and a refused gate or a
 * cut-off answer offers nothing. The model and the provider are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({ runLlmText: vi.fn() }));

vi.mock('../../lib/llmProvider', () => ({ resolveLanguageModel: vi.fn(async () => 'mock-model') }));
vi.mock('../../lib/llm/dispatch', async () => {
	const { metered } = await import('../../analytics/__tests__/meteredDispatch.testlib');
	return { runLlmText: metered((opts: unknown) => mocks.runLlmText(opts)) };
});

import { ledgerRows } from '../../analytics/__tests__/meteredDispatch.testlib';
import { rewriteSearch } from '../ai/searchRewrite';

type Handler = (ctx: unknown, args: unknown) => Promise<{ query: string | null }>;
const handler = (rewriteSearch as unknown as { _handler: Handler })._handler;

const GATE = 'mail/ai/gate:assertAiAllowed';

function ctx(gate: () => Promise<unknown> = async () => null) {
	return {
		runQuery: vi.fn(async () => null),
		runMutation: vi.fn(async (ref: unknown) =>
			getFunctionName(ref as never) === GATE ? gate() : null
		),
		scheduler: { runAfter: vi.fn(async () => null) },
	};
}

function answer(text: string, isTruncated = false) {
	return {
		text,
		tokenUsage: { promptTokens: 40, completionTokens: 8, totalTokens: 48 },
		isTruncated,
	};
}

beforeEach(() => {
	mocks.runLlmText.mockReset();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('rewriteSearch', () => {
	it('offers nothing and spends nothing for a query that already uses operators', async () => {
		const c = ctx();
		await expect(handler(c, { query: 'from:mia onboarding' })).resolves.toEqual({ query: null });
		expect(c.runMutation).not.toHaveBeenCalled();
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});

	it("passes the gate, asks with the browser's day and records the spend under its tag", async () => {
		mocks.runLlmText.mockResolvedValueOnce(
			answer('invoice has:attachment after:2026-09-01 before:2026-10-01')
		);
		const c = ctx();
		const result = await handler(c, {
			query: 'the invoice from the hosting company in september',
			today: '2026-11-04',
		});
		expect(result).toEqual({ query: 'invoice has:attachment after:2026-09-01 before:2026-10-01' });
		expect(c.runMutation.mock.calls.map(([ref]) => getFunctionName(ref as never))).toContain(GATE);
		const [opts] = mocks.runLlmText.mock.calls[0] as [{ system: string; prompt: string }];
		expect(opts.system).toContain('Today is 2026-11-04');
		expect(opts.prompt).toBe('Description: the invoice from the hosting company in september');
		expect(ledgerRows(c.runMutation, c.scheduler.runAfter).map((row) => row.feature)).toEqual([
			'postbox_search_rewrite',
		]);
	});

	it('does not call the model when the gate refuses', async () => {
		const c = ctx(async () => {
			throw new Error('AI features are disabled');
		});
		await expect(handler(c, { query: 'flight to lisbon' })).rejects.toThrow(
			'AI features are disabled'
		);
		expect(mocks.runLlmText).not.toHaveBeenCalled();
	});

	it('offers nothing when the answer was cut off', async () => {
		mocks.runLlmText.mockResolvedValueOnce(answer('from:airline subject:lis', true));
		await expect(handler(ctx(), { query: 'flight to lisbon' })).resolves.toEqual({ query: null });
	});
});
