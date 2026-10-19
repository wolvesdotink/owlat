/**
 * The scenarios measure only workloads the app can produce. Each writer limit
 * in perf/workload.ts is read back out of the source that enforces it, so a
 * change there fails here instead of leaving the fixture on the old shape.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitMentionSegments } from '@owlat/shared/chatMentions';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '~/utils/markdown';
import { SCENARIOS } from '../scenarios';
import {
	ASSISTANT_ANSWER_MAX_CHARS,
	assistantStreamWorkload,
	CHAT_CURRENT_USER_ID,
	chatHistoryWorkload,
	seededRandom,
	syntheticMarkdown,
	WRITER_LIMITS,
} from '../workload';

const CONVEX = resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/convex');
const convex = (path: string) => readFileSync(resolve(CONVEX, path), 'utf8');

/** The number `pattern`'s first group captures in `source`, underscores dropped. */
function declared(source: string, pattern: RegExp): number {
	const match = source.match(pattern);
	if (!match?.[1]) throw new Error(`${pattern} not found`);
	return Number(match[1].replaceAll('_', ''));
}

describe('writer limits match their sources', () => {
	it('assistant flush interval', () => {
		expect(declared(convex('assistant/runner.ts'), /const FLUSH_INTERVAL_MS = ([\d_]+);/)).toBe(
			WRITER_LIMITS.assistantFlushIntervalMs
		);
	});

	it('assistant output cap: assistant.answer uses LARGE_OUTPUT', () => {
		const policy = convex('lib/llm/taskPolicy.ts');
		expect(policy).toMatch(/'assistant\.answer': language\(\{\s*\.\.\.LARGE_OUTPUT,/);
		expect(declared(policy, /const LARGE_OUTPUT = \{ maxOutputTokens: ([\d_]+),/)).toBe(
			WRITER_LIMITS.assistantMaxOutputTokens
		);
	});

	it('assistant question length and history window', () => {
		const conversations = convex('assistant/conversations.ts');
		expect(declared(conversations, /const MESSAGE_MAX = ([\d_]+);/)).toBe(
			WRITER_LIMITS.assistantQuestionMaxChars
		);
		expect(declared(conversations, /const MESSAGES_LIMIT = ([\d_]+);/)).toBe(
			WRITER_LIMITS.assistantHistoryLimit
		);
	});

	it('chat message length and history window', () => {
		expect(declared(convex('chat/_helpers.ts'), /const MESSAGE_TEXT_MAX = ([\d_]+);/)).toBe(
			WRITER_LIMITS.chatMessageMaxChars
		);
		expect(
			declared(convex('chat/messages.ts'), /Math\.min\(args\.limit \?\? \d+, ([\d_]+)\)/)
		).toBe(WRITER_LIMITS.chatHistoryLimit);
	});
});

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
		expect(previous.length).toBeLessThanOrEqual(ASSISTANT_ANSWER_MAX_CHARS);
	});

	it('the near-cap stream ends exactly at the output cap', () => {
		const nearCap = streams.find((s) => s.id === 'assistant-stream/near-cap');
		expect(nearCap).toBeDefined();
		expect(assistantStreamWorkload(nearCap!).frames.at(-1)).toHaveLength(
			ASSISTANT_ANSWER_MAX_CHARS
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

	it('refuses a stream past the output cap or a history past the window', () => {
		const base = { seed: 1, historyTurns: 1, startChars: 0, flushes: 1, tokensPerSecond: 50 };
		expect(() =>
			assistantStreamWorkload({ ...base, startChars: ASSISTANT_ANSWER_MAX_CHARS })
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
