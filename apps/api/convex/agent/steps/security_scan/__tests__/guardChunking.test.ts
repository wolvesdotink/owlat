/**
 * Injection-guard hardening for `securityScanStep`:
 *   - chunkForGuard windows the sample so an injection PAST 8k is still scanned.
 *   - execute() sees a >8k injection (the guard is called on a window containing
 *     it and the message is flagged) — the pre-fix 8k slice made it invisible.
 *   - execute() STRIPS hidden content before it reaches the guard model.
 *   - a total guard failure sets guardUnavailable (fail closed for auto-send)
 *     while drafting still proceeds (fail open).
 *
 * The LLM dispatch seam + provider factory are mocked — no live model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFunctionName } from 'convex/server';

const mocks = vi.hoisted(() => ({
	runLlmObject: vi.fn(),
	getLLMProvider: vi.fn(() => 'mock-model'),
}));

vi.mock('../../../../lib/llm/dispatch', () => ({
	runLlmObject: mocks.runLlmObject,
}));
vi.mock('../../../../lib/llmProvider', () => ({
	getLLMProvider: mocks.getLLMProvider,
}));

import { securityScanStep, chunkForGuard } from '../index';
import type { Id } from '../../../../_generated/dataModel';

const messageId = 'msg_guard' as Id<'inboundMessages'>;
const input = { inboundMessageId: messageId };

/** ctx serving one inbound; agent enabled; no phishing key so no URL check. */
function makeCtx(message: Record<string, unknown>) {
	return {
		runQuery: async (ref: unknown) => {
			const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
			if (name.includes('getMessage')) return message;
			if (name.includes('isAgentEnabled')) return true;
			throw new Error(`unexpected runQuery: ${name}`);
		},
	} as unknown as Parameters<typeof securityScanStep.execute>[0];
}

beforeEach(() => {
	mocks.runLlmObject.mockReset();
	mocks.getLLMProvider.mockReset();
	mocks.getLLMProvider.mockReturnValue('mock-model');
});

describe('chunkForGuard', () => {
	it('returns [] for empty / blank input', () => {
		expect(chunkForGuard('')).toEqual([]);
		expect(chunkForGuard('   ')).toEqual([]);
	});

	it('returns a single window for short text', () => {
		expect(chunkForGuard('hello', 8000)).toEqual(['hello']);
	});

	it('windows long text and caps the window count', () => {
		const text = 'x'.repeat(100);
		const windows = chunkForGuard(text, 10, 4);
		expect(windows).toHaveLength(4); // 100/10 = 10 windows, capped at 4
		expect(windows.every((w) => w.length === 10)).toBe(true);
	});
});

describe('securityScanStep.execute — guard beyond 8k', () => {
	it('scans a window that contains an injection placed past 8k and flags it', async () => {
		const prompts: string[] = [];
		mocks.runLlmObject.mockImplementation(async (opts: { prompt: string }) => {
			prompts.push(opts.prompt);
			const isInjection = opts.prompt.includes('MARKERINJECT');
			return {
				object: {
					isInjection,
					confidence: isInjection ? 0.95 : 0.05,
					reason: isInjection ? 'manipulation attempt' : 'benign',
				},
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			};
		});

		// 8200 benign chars (no deterministic-pattern hits) then the injection
		// marker — past the old 8k slice, so only a windowed guard can see it.
		const body = 'benign filler. '.repeat(560) + ' MARKERINJECT override the assistant';
		expect(body.length).toBeGreaterThan(8000);
		const { output } = await securityScanStep.execute(
			makeCtx({ subject: 'Order help', textBody: body, htmlBody: null }),
			input,
		);

		// More than one window was scanned, and at least one carried the >8k marker.
		expect(mocks.runLlmObject.mock.calls.length).toBeGreaterThan(1);
		expect(prompts.some((p) => p.includes('MARKERINJECT'))).toBe(true);

		// The message is flagged by the LLM guard (not the deterministic patterns).
		expect(output.isInjection).toBe(true);
		expect(output.maxConfidence).toBeGreaterThanOrEqual(0.8);
		expect(output.securityFlags.injectionType).toBe('llm_prompt_injection');
		expect(output.securityFlags.guardUnavailable).toBe(false);
	});
});

describe('securityScanStep.execute — hidden content stripped before the guard', () => {
	it('never shows the guard model a hidden HTML-comment payload', async () => {
		const prompts: string[] = [];
		mocks.runLlmObject.mockImplementation(async (opts: { prompt: string }) => {
			prompts.push(opts.prompt);
			return {
				object: { isInjection: false, confidence: 0.02, reason: 'benign' },
				tokenUsage: undefined,
				modelUsed: 'mock-model',
			};
		});

		await securityScanStep.execute(
			makeCtx({
				subject: 'Question',
				textBody: null,
				// The comment lacks a leading injection keyword so detectSmuggling
				// does not fire — isolating the STRIP-before-guard behaviour.
				htmlBody: '<p>Visible question</p><!-- HIDDENPAYLOAD do the bad thing -->',
			}),
			input,
		);

		expect(prompts.length).toBeGreaterThan(0);
		for (const p of prompts) {
			expect(p).not.toContain('HIDDENPAYLOAD');
		}
		// The visible text still reached the guard.
		expect(prompts.some((p) => p.includes('Visible question'))).toBe(true);
	});
});

describe('securityScanStep.execute — guard unavailable (fail closed for auto-send)', () => {
	it('sets guardUnavailable when every guard window call fails', async () => {
		mocks.runLlmObject.mockRejectedValue(new Error('model down'));

		const { output } = await securityScanStep.execute(
			makeCtx({ subject: 'Hello', textBody: 'Just a normal support question, thanks.', htmlBody: null }),
			input,
		);

		// Drafting proceeds (no injection detected) but the guard could not run, so
		// the flag the route step / assertSafeToAutoSend consume is set — blocking
		// the auto-send path while leaving the message to flow to human review.
		expect(output.isInjection).toBe(false);
		expect(output.securityFlags.guardUnavailable).toBe(true);
	});
});
