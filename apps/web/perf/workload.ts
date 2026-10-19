/**
 * Synthetic workloads for the component performance scenarios.
 *
 * Every size and cadence here comes from `WRITER_LIMITS`
 * (scripts/perf-scenarios/writerLimits.ts), the production limits an API
 * contract test checks against the real policy, writer and queries, so a
 * scenario never measures a conversation or a stream the app cannot produce.
 *
 * Pure and deterministic: the same seed builds the same rows on every run and
 * machine, which is what lets the report compare runs at all.
 */
import { WRITER_LIMITS } from '../../../scripts/perf-scenarios/writerLimits';

export { WRITER_LIMITS };

/**
 * A planning estimate, not a tokenizer: English prose averages about four
 * characters a token. It turns the token cap into a character cap and a token
 * rate into characters per flush; the report states it next to the numbers.
 * Nothing here is ever tokenized, so a workload sized from it is an estimate.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * The estimated longest answer in characters: the output cap at
 * {@link CHARS_PER_TOKEN}. A real answer at the cap can be shorter or longer
 * depending on how its text tokenizes.
 */
export const ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS =
	WRITER_LIMITS.assistantMaxOutputTokens * CHARS_PER_TOKEN;

/** Deterministic PRNG (mulberry32): the same seed gives the same sequence everywhere. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Random = () => number;

const pick = <T>(rand: Random, items: readonly T[]): T =>
	items[Math.floor(rand() * items.length)] as T;
const between = (rand: Random, min: number, max: number) =>
	min + Math.floor(rand() * (max - min + 1));

const WORDS = [
	'campaign',
	'contacts',
	'segment',
	'open',
	'rate',
	'delivery',
	'bounce',
	'domain',
	'reputation',
	'warm-up',
	'audience',
	'engaged',
	'subject',
	'line',
	'template',
	'schedule',
	'weekly',
	'report',
	'inbox',
	'reply',
	'draft',
	'review',
	'the',
	'and',
	'with',
	'for',
	'over',
	'last',
	'month',
	'compared',
	'to',
	'previous',
	'quarter',
	'is',
	'about',
	'higher',
	'lower',
	'steady',
	'because',
	'most',
	'of',
	'our',
	'new',
	'signups',
] as const;

function sentence(rand: Random, words: number): string {
	const out: string[] = [];
	for (let i = 0; i < words; i++) {
		const word = pick(rand, WORDS);
		const roll = rand();
		if (roll < 0.05) out.push(`**${word}**`);
		else if (roll < 0.08) out.push(`\`${word}\``);
		else if (roll < 0.1) out.push(`[${word}](https://owlat.example/${word})`);
		else out.push(word);
	}
	const text = out.join(' ');
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function paragraph(rand: Random): string {
	const sentences = between(rand, 2, 5);
	return Array.from({ length: sentences }, () => sentence(rand, between(rand, 6, 18))).join(' ');
}

/**
 * One Markdown block of the kinds `parseMarkdown` (utils/markdown.ts) renders:
 * paragraphs most of the time, then lists, headings, code and quotes, roughly
 * the mix of a long analytical answer.
 */
function markdownBlock(rand: Random): string {
	const roll = rand();
	if (roll < 0.5) return paragraph(rand);
	if (roll < 0.68) {
		const ordered = rand() < 0.4;
		const items = between(rand, 3, 6);
		return Array.from(
			{ length: items },
			(_, i) => `${ordered ? `${i + 1}.` : '-'} ${sentence(rand, between(rand, 4, 12))}`
		).join('\n');
	}
	if (roll < 0.8)
		return `${'#'.repeat(between(rand, 2, 3))} ${sentence(rand, between(rand, 2, 5))}`;
	if (roll < 0.92) {
		const lines = between(rand, 3, 8);
		const body = Array.from(
			{ length: lines },
			(_, i) => `const ${pick(rand, WORDS).replace('-', '')}${i} = ${between(rand, 1, 999)};`
		).join('\n');
		return `\`\`\`ts\n${body}\n\`\`\``;
	}
	return `> ${sentence(rand, between(rand, 8, 16))}`;
}

/**
 * A Markdown answer of exactly `chars` characters (ASCII, so a prefix of it is
 * always a valid string). Built block by block and cut at the end, the same
 * way a stream is cut mid-block at every flush.
 */
export function syntheticMarkdown(seed: number, chars: number): string {
	const rand = seededRandom(seed);
	let text = '';
	while (text.length < chars) text += `${text ? '\n\n' : ''}${markdownBlock(rand)}`;
	return text.slice(0, chars);
}

/** The fields of an assistant message the components read (`AssistantMessageData`). */
export interface SyntheticAssistantRow {
	_id: string;
	role: 'user' | 'assistant';
	text: string;
	status: 'streaming' | 'complete' | 'stopped' | 'error';
	toolCalls: { status: string }[];
	errorMessage: string | null;
	budgetRefusal: null;
	model: string | null;
	createdAt: number;
}

const BASE_TIME = Date.UTC(2026, 8, 1, 9, 0, 0);

interface AssistantStreamWorkload {
	/** The settled turns above the streaming answer: questions and complete answers. */
	history: SyntheticAssistantRow[];
	/** The streaming answer's text when the scenario mounts. */
	initial: string;
	/** The streaming answer's text after each flush, in order. */
	frames: string[];
	/** Characters a flush adds (the token rate times the flush interval). */
	charsPerFlush: number;
}

interface AssistantStreamOptions {
	seed: number;
	/** Settled question/answer pairs above the stream. */
	historyTurns: number;
	/** Characters the answer already holds when the scenario mounts. */
	startChars: number;
	flushes: number;
	/** The model's output rate the stream models. */
	tokensPerSecond: number;
}

/**
 * A conversation with an answer streaming at the end, as the assistant page
 * receives it: one row write per flush interval, each carrying the whole answer
 * so far.
 */
export function assistantStreamWorkload(options: AssistantStreamOptions): AssistantStreamWorkload {
	const { seed, historyTurns, startChars, flushes, tokensPerSecond } = options;
	// The streaming turn adds two rows (its question and the answer).
	const rows = historyTurns * 2 + 2;
	if (rows > WRITER_LIMITS.assistantHistoryLimit) {
		throw new Error(
			`${rows} rows exceed the ${WRITER_LIMITS.assistantHistoryLimit}-message history a reader gets`
		);
	}
	const charsPerFlush = Math.round(
		((tokensPerSecond * WRITER_LIMITS.assistantFlushIntervalMs) / 1000) * CHARS_PER_TOKEN
	);
	const finalChars = startChars + charsPerFlush * flushes;
	if (finalChars > ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS) {
		throw new Error(
			`a ${finalChars}-character answer exceeds the estimated ${ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS}-character output cap`
		);
	}

	const rand = seededRandom(seed);
	const history: SyntheticAssistantRow[] = [];
	let at = BASE_TIME;
	const push = (role: SyntheticAssistantRow['role'], text: string) => {
		at += between(rand, 5, 90) * 1000;
		history.push({
			_id: `perf-msg-${history.length}`,
			role,
			text,
			status: 'complete',
			toolCalls: [],
			errorMessage: null,
			budgetRefusal: null,
			model: role === 'assistant' ? 'synthetic-model' : null,
			createdAt: at,
		});
	};
	for (let turn = 0; turn <= historyTurns; turn++) {
		const question = sentence(rand, between(rand, 8, 40));
		push('user', question.slice(0, WRITER_LIMITS.assistantQuestionMaxChars));
		if (turn < historyTurns) {
			push('assistant', syntheticMarkdown(seed + turn + 1, between(rand, 600, 3_000)));
		}
	}

	const answer = syntheticMarkdown(seed * 7919, finalChars);
	const frames = Array.from({ length: flushes }, (_, i) =>
		answer.slice(0, startChars + charsPerFlush * (i + 1))
	);
	return { history, initial: answer.slice(0, startChars), frames, charsPerFlush };
}

/** The fields of `chat.messages.listMessages` rows that `ChatMessage` reads. */
export interface SyntheticChatRow {
	_id: string;
	roomId: string;
	authorId: string;
	author: { name: string | null; email: string | null; image: string | null };
	isAssistant: boolean;
	text: string;
	mentions: string[];
	createdAt: number;
	_creationTime: number;
}

const AUTHORS = [
	{ id: 'perf-user-ada', name: 'Ada Lovelace', handle: 'ada' },
	{ id: 'perf-user-grace', name: 'Grace Hopper', handle: 'grace' },
	{ id: 'perf-user-alan', name: 'Alan Turing', handle: 'alan' },
	{ id: 'perf-user-katherine', name: 'Katherine Johnson', handle: 'katherine' },
	{ id: 'perf-user-edsger', name: 'Edsger Dijkstra', handle: 'edsger' },
	{ id: 'perf-user-barbara', name: 'Barbara Liskov', handle: 'barbara' },
] as const;

/** The member the chat scenario renders as: their own rows carry the edit/delete actions. */
export const CHAT_CURRENT_USER_ID: string = AUTHORS[0].id;

interface ChatHistoryOptions {
	seed: number;
	messages: number;
	/** Calendar days the history spans, so the list renders its date separators. */
	days: number;
}

/**
 * A room's loaded history at the subscription's cap: mostly short lines, some
 * paragraphs, a few messages at the full writer limit, and @-mentions.
 */
export function chatHistoryWorkload(options: ChatHistoryOptions): SyntheticChatRow[] {
	const { seed, messages, days } = options;
	if (messages > WRITER_LIMITS.chatHistoryLimit) {
		throw new Error(
			`${messages} messages exceed the ${WRITER_LIMITS.chatHistoryLimit}-message window`
		);
	}
	const rand = seededRandom(seed);
	const step = (days * 24 * 3600 * 1000) / Math.max(1, messages);
	return Array.from({ length: messages }, (_, i) => {
		const author = pick(rand, AUTHORS);
		const roll = rand();
		let text: string;
		if (i % 125 === 124) {
			// A few messages at the full limit: the longest row the list can hold.
			text = syntheticMarkdown(seed + i, WRITER_LIMITS.chatMessageMaxChars);
		} else if (roll < 0.7) {
			text = sentence(rand, between(rand, 3, 25));
		} else {
			text = Array.from({ length: between(rand, 1, 4) }, () => paragraph(rand)).join('\n\n');
		}
		const mentioned = rand() < 0.08 ? pick(rand, AUTHORS) : null;
		if (mentioned) text = `@${mentioned.handle} ${text}`;
		const createdAt = BASE_TIME + Math.round(i * step);
		return {
			_id: `perf-chat-${i}`,
			roomId: 'perf-room',
			authorId: author.id,
			author: { name: author.name, email: null, image: null },
			isAssistant: false,
			text: text.slice(0, WRITER_LIMITS.chatMessageMaxChars),
			mentions: mentioned ? [mentioned.id] : [],
			createdAt,
			_creationTime: createdAt,
		};
	});
}
