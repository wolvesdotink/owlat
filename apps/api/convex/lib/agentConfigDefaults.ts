/**
 * The values a first `agentConfig` row starts with when a setting creates it
 * (`agent/configMutations.ts setReplyMode`, `decision/exclusion.ts`). A leaf
 * module, so both can import it without a dependency cycle.
 */
export const AGENT_CONFIG_INSERT_DEFAULTS = {
	confidenceThreshold: 0.8,
	maxDailyAutoReplies: 100,
	coalesceWindowMs: 30000,
} as const;
