/**
 * Deliverability Lab — a Tier-1/2/3 reference plugin.
 *
 * It runs the same deterministic pre-send analysis (spam score + link and
 * accessibility audits) across all three plugin tiers:
 *   - Tier 1: a restrict-only `sendGate` (`./gate`) that holds an autonomous
 *     send when a draft fails preflight, plus bundled nav/settings UI and a
 *     budgeted tip `cron` (`./cron`);
 *   - Tier 2: an OPTIONAL seedbox score consumed over Owlat's signed `score`
 *     hook, with a deadline and a fail-closed fallback to local scoring
 *     (`./remoteScore`);
 *   - Tier 3: a seed-list placement test enqueued onto the sandboxed worker
 *     (`./seedTest`), run by `apps/code-worker`'s host-controlled command.
 *
 * Every module is runtime-neutral and individually testable; the wire is the
 * plugin manifest plus the host contribution contracts from `@owlat/plugin-kit`.
 */

export { deliverabilityLabPlugin } from './manifest';
export {
	DELIVERABILITY_LAB_DAILY_LLM_BUDGET_USD,
	DELIVERABILITY_LAB_SEEDBOX_URL_ENV,
} from './manifest';
export { DELIVERABILITY_LAB_PLUGIN_ID } from './constants';

export {
	analyzeEmail,
	auditAccessibility,
	auditLinks,
	normalizeSpamScore,
	scoreSpam,
	summarizeFailure,
	verdictOf,
	worstVerdict,
	SPAM_FAIL_THRESHOLD,
	SPAM_SCORE_MAX,
	SPAM_WARN_THRESHOLD,
	type AccessibilityReport,
	type DeliverabilityEmail,
	type DeliverabilityReport,
	type Finding,
	type FindingSeverity,
	type LinkAuditReport,
	type SpamScoreReport,
	type Verdict,
} from './engine';

export {
	createDeliverabilityGate,
	deliverabilityGate,
	DEFAULT_REMOTE_DEADLINE_MS,
	REMOTE_SCORE_FAIL_THRESHOLD,
	type DeliverabilityGateConfig,
} from './gate';

export {
	localFallbackScore,
	parseScoreHookResult,
	scoreDeliverability,
	SCORE_HOOK_REASON_MAX_LENGTH,
	type DeliverabilityScore,
	type RemoteScoreHook,
	type ScoreDeliverabilityOptions,
	type ScoreHookResult,
	type ScoreSource,
} from './remoteScore';

export {
	buildSeedTestPayload,
	parseSeedTestResult,
	SeedTestPayloadError,
	SEED_TEST_LOCAL_ID,
	SEED_TEST_MAX_SEEDS,
	type SeedFolder,
	type SeedPlacement,
	type SeedTestEnqueueRequest,
	type SeedTestPayload,
	type SeedTestResult,
} from './seedTest';

export {
	buildDeliverabilityTipRequest,
	deliverabilityTipTopic,
	DELIVERABILITY_TIP_TOPICS,
} from './insights';
export {
	createDeliverabilityTipCron,
	refreshSeedScoresCron,
	TIP_LOG_MAX_LENGTH,
	type DeliverabilityTipCronConfig,
} from './cron';
