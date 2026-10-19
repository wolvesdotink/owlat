/**
 * The named scenarios: two families, three workloads. Shared by the runner
 * (which picks and repeats them) and the browser fixture (which builds and
 * mounts them), so both always mean the same workload by the same id.
 */
import { ASSISTANT_ANSWER_MAX_CHARS, CHARS_PER_TOKEN, WRITER_LIMITS } from './workload';

/** A model writing at a steady 50 tokens a second: 50 characters per 250 ms flush. */
const TOKENS_PER_SECOND = 50;
/** Twelve seconds of stream at the real cadence. */
const STREAM_FLUSHES = 48;
const STREAM_CHARS = Math.round(
	((TOKENS_PER_SECOND * WRITER_LIMITS.assistantFlushIntervalMs) / 1000) *
		CHARS_PER_TOKEN *
		STREAM_FLUSHES
);

export interface AssistantStreamScenario {
	id: string;
	family: 'assistant-stream';
	description: string;
	seed: number;
	historyTurns: number;
	startChars: number;
	flushes: number;
	tokensPerSecond: number;
}

export interface ChatHistoryScenario {
	id: string;
	family: 'chat-history';
	description: string;
	seed: number;
	messages: number;
	days: number;
	/** Pixels scrolled per animation frame, top to bottom of the loaded history. */
	scrollStepPx: number;
}

type Scenario = AssistantStreamScenario | ChatHistoryScenario;

export const SCENARIOS: readonly Scenario[] = [
	{
		id: 'assistant-stream/start',
		family: 'assistant-stream',
		description:
			'An answer streaming from empty under 20 settled turns, one flush per 250 ms, then teardown.',
		seed: 73,
		historyTurns: 20,
		startChars: 0,
		flushes: STREAM_FLUSHES,
		tokensPerSecond: TOKENS_PER_SECOND,
	},
	{
		id: 'assistant-stream/near-cap',
		family: 'assistant-stream',
		description:
			'The last 12 s of an answer that ends at the 8,192-token output cap, under 20 settled turns, then teardown.',
		seed: 73,
		historyTurns: 20,
		startChars: ASSISTANT_ANSWER_MAX_CHARS - STREAM_CHARS,
		flushes: STREAM_FLUSHES,
		tokensPerSecond: TOKENS_PER_SECOND,
	},
	{
		id: 'chat-history/500',
		family: 'chat-history',
		description:
			'A room at its 500-message window over 14 days: mount at the newest message, scroll to the oldest, then teardown.',
		seed: 1019,
		messages: WRITER_LIMITS.chatHistoryLimit,
		days: 14,
		scrollStepPx: 120,
	},
];

export function scenarioById(id: string): Scenario {
	const scenario = SCENARIOS.find((s) => s.id === id);
	if (!scenario) throw new Error(`unknown scenario '${id}'`);
	return scenario;
}
