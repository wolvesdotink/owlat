/**
 * The named scenarios: four families. Shared by the runner
 * (which picks and repeats them) and the browser fixture (which builds and
 * mounts them), so both always mean the same workload by the same id.
 */
import { POSTBOX_VIRTUAL_THRESHOLD } from '../app/utils/postboxDensity';
import { ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS, CHARS_PER_TOKEN, WRITER_LIMITS } from './workload';

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

export interface PostboxListScenario {
	id: string;
	family: 'postbox-list';
	description: string;
	seed: number;
	/** Rows the folder holds, newest first. */
	rows: number;
	spanHours: number;
	/** Pixels scrolled per animation frame, top to bottom of the folder. */
	scrollStepPx: number;
}

export interface TeamInboxScenario {
	id: string;
	family: 'team-inbox';
	description: string;
	seed: number;
	threads: number;
	spanHours: number;
}

export type Scenario =
	| AssistantStreamScenario
	| ChatHistoryScenario
	| PostboxListScenario
	| TeamInboxScenario;

/** Rows one folder page returns (`usePostboxThreads` asks the folder query for 50). */
const POSTBOX_FOLDER_PAGE = 50;
/** Threads one Team Inbox page returns (`useInbox` asks `listThreads` for 25). */
const TEAM_INBOX_PAGE = 25;

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
		description: `The last 12 s of an estimated near-cap answer: ${ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS.toLocaleString('en-US')} characters, the ${WRITER_LIMITS.assistantMaxOutputTokens.toLocaleString('en-US')}-token output cap at an assumed ${CHARS_PER_TOKEN} characters a token (never tokenized), under 20 settled turns, then teardown.`,
		seed: 73,
		historyTurns: 20,
		startChars: ASSISTANT_ANSWER_ESTIMATED_MAX_CHARS - STREAM_CHARS,
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
	{
		id: 'postbox-list/50',
		family: 'postbox-list',
		description: `A Postbox folder's first page (${POSTBOX_FOLDER_PAGE} rows, under the ${POSTBOX_VIRTUAL_THRESHOLD}-row windowing threshold, so every row mounts): mount, one row marked read by a live update, scroll to the end, then teardown.`,
		seed: 2207,
		rows: POSTBOX_FOLDER_PAGE,
		spanHours: 30,
		scrollStepPx: 120,
	},
	{
		id: 'postbox-list/500',
		family: 'postbox-list',
		description: `A Postbox folder after nine "Load more" pages (${POSTBOX_FOLDER_PAGE * 10} rows, over the ${POSTBOX_VIRTUAL_THRESHOLD}-row threshold, so only a window of rows mounts): mount, one row marked read by a live update, scroll to the end, then teardown.`,
		seed: 2207,
		rows: POSTBOX_FOLDER_PAGE * 10,
		spanHours: 24 * 21,
		scrollStepPx: 120,
	},
	{
		id: 'team-inbox/100',
		family: 'team-inbox',
		description: `The Team Inbox list after three "Load more" pages (${TEAM_INBOX_PAGE * 4} threads): mount, one thread read by a live update, one tick of the list clock, then teardown.`,
		seed: 3301,
		threads: TEAM_INBOX_PAGE * 4,
		spanHours: 72,
	},
];

export function scenarioById(id: string): Scenario {
	const scenario = SCENARIOS.find((s) => s.id === id);
	if (!scenario) throw new Error(`unknown scenario '${id}'`);
	return scenario;
}
