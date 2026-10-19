/**
 * The scenario workloads stay inside the production limits in
 * scripts/perf-scenarios/writerLimits.ts. Whether those limits are still the
 * effective ones is the API's side of the contract:
 * apps/api/convex/__tests__/perfScenarioWriterLimits.integration.test.ts.
 */
import { splitMentionSegments } from '@owlat/shared/chatMentions';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '~/utils/markdown';
import { SCENARIOS } from '../scenarios';
import {
	ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS,
	assistantStreamWorkload,
	CHAT_CURRENT_USER_ID,
	chatHistoryWorkload,
	seededRandom,
	syntheticMarkdown,
	WRITER_LIMITS,
} from '../workload';

describe('assistant stream workloads', () => {
	const streams = SCENARIOS.flatMap((s) => (s.family === 'assistant-stream' ? [s] : []));

	it.each(streams)('$id stays inside the writer limits', (scenario) => {
		const workload = assistantStreamWorkload(scenario);
		expect(workload.history.length + 1).toBeLessThanOrEqual(WRITER_LIMITS.assistantHistoryLimit);
		for (const row of workload.history.filter((r) => r.role === 'user')) {
			expect(row.text.length).toBeLessThanOrEqual(WRITER_LIMITS.assistantQuestionMaxChars);
		}
		expect(workload.frames).toHaveLength(scenario.flushes);
		expect(workload.initial).toHaveLength(scenario.startChars);
		// Every flush carries the whole answer so far, one interval's output longer.
		let previous = workload.initial;
		for (const frame of workload.frames) {
			expect(frame.startsWith(previous)).toBe(true);
			expect(frame.length - previous.length).toBe(workload.charsPerFlush);
			previous = frame;
		}
		expect(previous.length).toBeLessThanOrEqual(ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS);
	});

	it('the near-cap stream ends at the estimated output cap in characters', () => {
		const nearCap = streams.find((s) => s.id === 'assistant-stream/near-cap');
		expect(nearCap).toBeDefined();
		expect(assistantStreamWorkload(nearCap!).frames.at(-1)).toHaveLength(
			ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS
		);
	});

	it('50 tokens a second at the 250 ms cadence is 50 characters a flush', () => {
		const { charsPerFlush } = assistantStreamWorkload({
			seed: 1,
			historyTurns: 0,
			startChars: 0,
			flushes: 1,
			tokensPerSecond: 50,
		});
		expect(charsPerFlush).toBe(50);
	});

	it('refuses a stream past the estimated output cap or a history past the window', () => {
		const base = { seed: 1, historyTurns: 1, startChars: 0, flushes: 1, tokensPerSecond: 50 };
		expect(() =>
			assistantStreamWorkload({ ...base, startChars: ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS })
		).toThrow(/output cap/);
		expect(() => assistantStreamWorkload({ ...base, historyTurns: 250 })).toThrow(/history/);
	});

	it('streams Markdown with every block kind the renderer handles', () => {
		const kinds = new Set(parseMarkdown(syntheticMarkdown(73, 20_000)).map((b) => b.type));
		expect([...kinds].sort()).toEqual(['blockquote', 'code', 'heading', 'list', 'paragraph']);
	});
});

describe('chat history workload', () => {
	const scenario = SCENARIOS.find((s) => s.family === 'chat-history');
	if (scenario?.family !== 'chat-history') throw new Error('no chat-history scenario');
	const rows = chatHistoryWorkload(scenario);

	it('fills the window and no message passes the length limit', () => {
		expect(rows).toHaveLength(WRITER_LIMITS.chatHistoryLimit);
		expect(Math.max(...rows.map((r) => r.text.length))).toBe(WRITER_LIMITS.chatMessageMaxChars);
	});

	it('spans several days, has own rows and real @-mentions', () => {
		const days = new Set(rows.map((r) => new Date(r.createdAt).toISOString().slice(0, 10)));
		expect(days.size).toBeGreaterThanOrEqual(scenario.days);
		expect(rows.some((r) => r.authorId === CHAT_CURRENT_USER_ID)).toBe(true);
		const mentioned = rows.filter((r) =>
			splitMentionSegments(r.text).some((s) => s.kind === 'mention')
		);
		expect(mentioned.length).toBeGreaterThan(0);
		expect(mentioned.every((r) => r.mentions.length === 1)).toBe(true);
	});

	it('refuses more rows than the window', () => {
		expect(() =>
			chatHistoryWorkload({ seed: 1, messages: WRITER_LIMITS.chatHistoryLimit + 1, days: 1 })
		).toThrow(/window/);
	});
});

describe('determinism', () => {
	it('the same seed builds the same workload', () => {
		const a = seededRandom(42);
		const b = seededRandom(42);
		expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
		for (const scenario of SCENARIOS) {
			const build = () =>
				scenario.family === 'assistant-stream'
					? assistantStreamWorkload(scenario)
					: chatHistoryWorkload(scenario);
			expect(build()).toEqual(build());
		}
	});

	it('scenario ids are unique', () => {
		expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
	});
});
