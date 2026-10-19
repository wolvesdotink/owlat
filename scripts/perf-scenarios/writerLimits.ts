/**
 * The production limits the component performance scenarios (apps/web/perf,
 * plan item OW-073) build their workloads inside: how often the assistant
 * writes a streaming answer, how long an answer, a question and a chat message
 * can get, and how much history a reader is handed.
 *
 * One module for both sides. The scenario workloads (apps/web/perf/workload.ts)
 * size themselves from it, and the API contract test
 * (apps/api/convex/__tests__/perfScenarioWriterLimits.integration.test.ts)
 * checks each value against the real policy resolver, writer and queries, so a
 * change of an effective limit fails that test instead of leaving the fixture
 * measuring the old shape. It lives under the root scripts/ because neither
 * workspace may import the other by a relative path (lint:imports).
 */
export const WRITER_LIMITS = {
	/** The assistant runner writes a streaming answer at most once per this interval. */
	assistantFlushIntervalMs: 250,
	/**
	 * The output ceiling of `assistant.answer`: the visible-output allowance a
	 * model with a separate reasoning budget is sent. A combined-budget model is
	 * sent this plus the reasoning allowance and may spend either on text.
	 */
	assistantMaxOutputTokens: 8_192,
	/** The longest question `assistant.conversations.sendMessage` accepts, in characters. */
	assistantQuestionMaxChars: 8_000,
	/** The newest messages `assistant.conversations.listMessages` returns. */
	assistantHistoryLimit: 500,
	/** The longest message `chat.messages.sendMessage` accepts, in characters. */
	chatMessageMaxChars: 8_000,
	/** The most rows one `chat.messages.listMessages` page returns, whatever `limit` asks. */
	chatHistoryLimit: 500,
} as const;
