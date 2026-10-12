'use node';

/**
 * `security_scan` Agent step (module) — see ADR-0014 and ADR-0073.
 *
 * Pattern-based prompt-injection + instruction-smuggling + spam-heuristic
 * scan over the inbound email, URL reputation, and a guard-tier LLM
 * prompt-injection classifier (./guard.ts). Quarantines high-confidence
 * injections, archives high-spam-score messages, otherwise advances to
 * context retrieval.
 *
 * Defense in depth: the deterministic patterns catch the known attack
 * shapes; the guard-tier LLM catches novel/obfuscated phrasings the
 * regexes miss. We OR the two — either flagging with high confidence is
 * treated as an injection. The LLM call fails OPEN: any model error falls
 * back to the pattern-only verdict so a flaky model never blocks the
 * pipeline.
 *
 * Call order (Phase 1c, ./disposition.ts):
 *   1. Every deterministic layer runs first, URL reputation included. A
 *      quarantine they confirm ends the step without a guard call (L1).
 *   2. D13: the guard is skipped for mail archived on its spam score (or on the
 *      MTA verdict, behind `mtaVerdictTerminal`) and for mail arriving while
 *      the agent is off. The skip is recorded as `securityFlags.guardNotRun`,
 *      and every later autonomous path requires the guard first.
 *   3. Otherwise the guard runs, and then, behind `earlyRuleArchive`, handling
 *      rules without a category facet may archive the message before
 *      retrieval and classification (L4).
 */

import type { Infer } from 'convex/values';
import { resolveRoutingPolicy, type ResolvedRoutingPolicy } from '@owlat/shared/aiRouting';
import { openInboundMessageBody } from '../../../lib/messageBodyInbound';
import {
	checkUrlReputation,
	type CachedVerdict,
	type UrlReputationCache,
} from '@owlat/email-scanner';
import { internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ActionCtx } from '../../../_generated/server';
import type { AgentStepModule } from '../types';
import type { securityFlagsValidator } from '../../../lib/convexValidators';
import { getOptional } from '../../../lib/env';
import { admissionRefusalOf } from '../../../lib/llm/admissionPort';
import { detectInjection, detectSmuggling, calculateSpamScore } from './patterns';
import { buildGuardSample, isGuardFlagged, runModelGuard, type GuardScanResult } from './guard';
import {
	guardSkipReason,
	isDeterministicQuarantine,
	isMtaVerdictTerminal,
	scanDisposition,
} from './disposition';
import { scheduleTeamTriage } from '../../../decision/schedule';

// The guard helpers moved to ./guard.ts; re-exported so existing importers keep
// one import surface.
export { chunkForGuard } from './guard';

/**
 * Convex-backed {@link UrlReputationCache} adapter over the shared
 * `urlReputationCache` table (campaigns/sendQueries.ts). Repeated links across
 * inbound mail are served from cache instead of re-hitting the Safe Browsing API
 * (free tier is 10k/day). `get` honors the stored TTL; `set` upserts so the
 * table never accumulates duplicate verdicts for one normalized URL.
 */
function convexUrlReputationCache(ctx: ActionCtx): UrlReputationCache {
	return {
		async get(urlHash) {
			const row = await ctx.runQuery(internal.campaigns.sendQueries.getUrlReputationVerdict, {
				urlHash,
			});
			return row;
		},
		async set(urlHash, verdict: CachedVerdict) {
			await ctx.runMutation(internal.campaigns.sendQueries.upsertUrlReputationVerdict, {
				urlHash,
				verdict: verdict.verdict,
				source: verdict.source,
				threats: verdict.threats,
				checkedAt: verdict.checkedAt,
				expiresAt: verdict.expiresAt,
			});
		},
	};
}

/**
 * Layer 5: URL reputation (Google Safe Browsing). Extracts the links from the
 * inbound HTML body and flags the message if any resolve to a malicious or
 * suspicious verdict. Gated on `GOOGLE_SAFE_BROWSING_API_KEY` — without a key
 * configured this is a no-op that returns `false` (preserving the prior
 * behavior), so the feature is purely additive defense-in-depth. Fails OPEN:
 * any error (network, API, cache) returns `false` so a flaky reputation service
 * never blocks the inbound pipeline. Verdicts are cached in the shared
 * `urlReputationCache` table so the same link isn't re-checked across messages.
 */
async function detectPhishingUrls(
	ctx: ActionCtx,
	htmlBody: string | undefined | null
): Promise<boolean> {
	const apiKey = getOptional('GOOGLE_SAFE_BROWSING_API_KEY');
	if (!apiKey || !htmlBody) return false;

	try {
		const results = await checkUrlReputation(htmlBody, {
			apiKey,
			cache: convexUrlReputationCache(ctx),
		});
		// `checkUrlReputation` only returns non-safe verdicts.
		return results.length > 0;
	} catch {
		// Fail open — a reputation-service hiccup must not block inbound mail.
		return false;
	}
}

// The canonical inboundMessages.securityFlags shape (lib/convexValidators.ts). This
// step always populates `spamScore`, `phishingDetected`, and `guardUnavailable`,
// which the validator marks optional — a fully-populated value is assignable.
type SecurityFlags = Infer<typeof securityFlagsValidator>;

interface SecurityScanInput {
	inboundMessageId: Id<'inboundMessages'>;
}

interface SecurityScanOutput {
	securityFlags: SecurityFlags;
	isInjection: boolean;
	maxConfidence: number;
	spamScore: number;
	phishingDetected: boolean;
	agentEnabled: boolean;
	/** L5: the MTA's verdict as ingest recorded it (absent: an older MTA). */
	mtaSpamVerdict?: 'ham' | 'spam' | 'quarantine';
	/** L5: the verdict ends the run (`mtaVerdictTerminal` is on and it is not ham). */
	isMtaVerdictTerminal?: boolean;
	/** L4: an early handling rule archives the message (`earlyRuleArchive` is on). */
	isEarlyRuleArchive?: boolean;
}

/**
 * The routing policy, or its defaults (today's behaviour) when it cannot be
 * read. Every switch this step reads only ever adds an early stop, so the
 * defaults are the safe reading.
 */
async function loadPolicy(ctx: ActionCtx): Promise<ResolvedRoutingPolicy> {
	try {
		return await ctx.runQuery(internal.aiRouting.policy.getResolved, {});
	} catch {
		return resolveRoutingPolicy(null);
	}
}

/**
 * L4: does an enabled handling rule with no category facet archive this
 * message? Evaluated with the same sender, subject and bounded body inputs the
 * classify step uses. FAIL-SOFT: a failure leaves the message on its normal
 * path, where the classify step evaluates every rule again as it does today.
 */
async function earlyRuleArchives(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>
): Promise<boolean> {
	try {
		const rules = await ctx.runQuery(internal.mail.handlingRules.evaluateForMessage, {
			inboundMessageId,
			isPreClassify: true,
		});
		return rules.autoArchive;
	} catch {
		return false;
	}
}

const NO_GUARD_RUN: GuardScanResult = { verdict: undefined, incomplete: false };

/** The guard's scan, or the spend admission refusal that stopped it (D1). */
async function guardOrRefusal(
	ctx: ActionCtx,
	inboundMessageId: Id<'inboundMessages'>,
	sample: string
): Promise<{ guardScan: GuardScanResult; refusal: unknown }> {
	try {
		return { guardScan: await runModelGuard(ctx, inboundMessageId, sample), refusal: undefined };
	} catch (error) {
		if (!admissionRefusalOf(error)) throw error;
		return { guardScan: NO_GUARD_RUN, refusal: error };
	}
}

export const securityScanStep: AgentStepModule<
	'security_scan',
	SecurityScanInput,
	SecurityScanOutput
> = {
	kind: 'security_scan',

	async execute(ctx, input) {
		const message = await ctx.runQuery(internal.agent.agentPipeline.getMessage, {
			inboundMessageId: input.inboundMessageId,
		});
		if (!message) throw new Error('Inbound message not found');
		const { text: bodyText, html: bodyHtml } = await openInboundMessageBody(message, ctx.storage);

		// ── Layer 1: Prompt injection detection on text body ──
		const textContent = bodyText ?? message.subject ?? '';
		const injectionResult = detectInjection(textContent);

		// Also check HTML body for injection
		const htmlInjection = bodyHtml
			? detectInjection(bodyHtml)
			: { detected: false, confidence: 0, pattern: undefined };

		// ── Layer 2: Instruction smuggling in HTML ──
		const smugglingResult = detectSmuggling(bodyHtml);

		// ── Layer 3: Basic spam heuristics ──
		const spamScore = calculateSpamScore(textContent, message.subject);

		// ── Layer 4: URL reputation (Google Safe Browsing, key-gated, fails open) ──
		const phishingDetected = await detectPhishingUrls(ctx, bodyHtml);

		const patternInjection =
			injectionResult.detected || htmlInjection.detected || smugglingResult.detected;
		const patternConfidence = Math.max(
			injectionResult.confidence,
			htmlInjection.confidence,
			smugglingResult.detected ? 0.8 : 0
		);

		const policy = await loadPolicy(ctx);
		const agentEnabled = await ctx.runQuery(internal.agent.agentPipeline.isAgentEnabled, {});
		const mtaTerminal = isMtaVerdictTerminal(policy, message.mtaSpamVerdict);

		// ── Layer 5: Guard-tier LLM injection classifier (fails open) ──
		// Not called when the deterministic layers already quarantine (L1) or
		// when D13 skips it; the skip is recorded below.
		const deterministicQuarantine = isDeterministicQuarantine({
			patternInjection,
			patternConfidence,
			phishingDetected,
		});
		const skipReason = deterministicQuarantine
			? null
			: guardSkipReason({ spamScore, isMtaVerdictTerminal: mtaTerminal, agentEnabled });
		const runsGuard = !deterministicQuarantine && skipReason === null;
		const guardSample = runsGuard ? buildGuardSample(message.subject, bodyText, bodyHtml) : '';
		const { guardScan, refusal } = runsGuard
			? await guardOrRefusal(ctx, input.inboundMessageId, guardSample)
			: { guardScan: NO_GUARD_RUN, refusal: undefined };
		// D13 marker: skipped by policy, or refused by spend admission (D1).
		const notRunReason = skipReason ?? (refusal ? ('budget_refused' as const) : null);
		const llmVerdict = guardScan.verdict;
		const llmFlagged = isGuardFlagged(llmVerdict);
		// `incomplete`: the guard did not fully classify the sample (a total or a
		// partial model failure). With text to classify that marks the guard
		// unavailable, so the route step fails CLOSED on auto-send while drafting
		// still proceeds (fail open).
		const guardUnavailable = guardScan.incomplete && guardSample.trim().length > 0;

		// ── Aggregate ──
		// Either the deterministic patterns OR the high-confidence LLM verdict
		// flags injection.
		const isInjection = patternInjection || llmFlagged;
		const maxConfidence = Math.max(patternConfidence, llmFlagged ? llmVerdict.confidence : 0);

		const injectionType = !isInjection
			? undefined
			: smugglingResult.detected
				? `smuggling:${smugglingResult.type}`
				: patternInjection
					? 'prompt_injection'
					: 'llm_prompt_injection';

		const flaggedContent = !isInjection
			? undefined
			: (smugglingResult.content ??
				injectionResult.pattern ??
				htmlInjection.pattern ??
				(llmFlagged ? llmVerdict.reason : undefined));

		const scanTimestamp = Date.now();
		const securityFlags: SecurityFlags = {
			injectionDetected: isInjection,
			injectionType,
			confidence: maxConfidence,
			flaggedContent,
			spamScore,
			phishingDetected,
			guardUnavailable,
			...(notRunReason ? { guardNotRun: { reason: notRunReason, at: scanTimestamp } } : {}),
			scanTimestamp,
		};

		// Spend admission refused the guard (D1, Sol r3 F1): the deterministic
		// verdict is stored with the `guardNotRun` marker, so every later
		// generative consumer runs the guard first, and the refusal goes on to
		// the walker, which holds the message.
		if (refusal) {
			await ctx.runMutation(internal.inbox.stepOutputs.recordSecurityScan, {
				inboundMessageId: input.inboundMessageId,
				securityFlags,
			});
			throw refusal;
		}

		const output: SecurityScanOutput = {
			securityFlags,
			isInjection,
			maxConfidence,
			spamScore,
			phishingDetected,
			agentEnabled,
			...(message.mtaSpamVerdict ? { mtaSpamVerdict: message.mtaSpamVerdict } : {}),
			isMtaVerdictTerminal: mtaTerminal,
			isEarlyRuleArchive: false,
		};

		const disposition = scanDisposition(output);
		if (disposition === 'continue' && policy.earlyRuleArchive === 'enforce') {
			output.isEarlyRuleArchive = await earlyRuleArchives(ctx, input.inboundMessageId);
		}
		// D11: the guard passed and nothing ends the run before retrieval, so
		// the message-only triage shadow may observe it (only at `shadow`).
		if (scanDisposition(output) === 'continue') {
			await scheduleTeamTriage(ctx, policy, input.inboundMessageId);
		}
		// The agent-off path ends without a transition, so the scan (and its
		// D13 marker) is stored here. Not fail-soft: the marker is what later
		// autonomous paths check.
		if (disposition === 'agent_off') {
			await ctx.runMutation(internal.inbox.stepOutputs.recordSecurityScan, {
				inboundMessageId: input.inboundMessageId,
				securityFlags,
			});
		}

		return { output };
	},

	route(output, _input, runCtx) {
		switch (scanDisposition(output)) {
			// Quarantine: high-confidence injection OR a known-malicious/phishing
			// URL. A Safe-Browsing hit is a deterministic indicator of a weaponized
			// link, so it gates the message into quarantine just like a
			// high-confidence injection rather than letting the agent draft a reply.
			case 'quarantine':
				return {
					kind: 'transition',
					transition: { to: 'quarantined', securityFlags: output.securityFlags },
				};
			// Archive: spam without agent processing.
			case 'archive_spam':
				return {
					kind: 'transition',
					transition: { to: 'archived', reason: 'spam', securityFlags: output.securityFlags },
				};
			// Clean + agent disabled — the scan is recorded (execute) and the run stops.
			case 'agent_off':
				return { kind: 'done' };
			// L4: an `auto_archive` handling rule matched before classification.
			case 'archive_handling_rule':
				return {
					kind: 'transition',
					transition: {
						to: 'archived',
						reason: 'handling_rule_archive',
						securityFlags: output.securityFlags,
					},
				};
			// Clean — advance into classifying and schedule context retrieval.
			case 'continue':
				return {
					kind: 'transition',
					transition: { to: 'classifying', securityFlags: output.securityFlags },
					nextStep: {
						kind: 'context_retrieval',
						input: { inboundMessageId: runCtx.inboundMessageId },
					},
				};
		}
	},
};
