import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Autonomy / graduated-trust tables — the safety + graduation machinery that
 * governs when the inbound agent is allowed to auto-send.
 *
 * agentConfig is the singleton control panel (auto-reply master, thresholds,
 * send-delay/undo window, shadow mode, working-hours window); agentCircuitBreakers
 * are the automated kill mechanisms; autonomyRules hold the per-category /
 * per-sender auto-approval configuration (incl. auto-demotion incidents);
 * autonomyFeedback + autonomySuggestions drive the threshold-calibration loop and
 * the explicit graduation nudges; agentShadowDecisions + agentShadowScorecard are
 * the "would-have-sent" shadow observations that back the graduation scorecard.
 *
 * Split out of schema/inbox.ts (CONVENTIONS "split only above ~500 LOC").
 * Spread into `defineSchema()` from schema.ts via `...autonomyTables`.
 */
export const autonomyTables = {
	// Agent Config - operational tuning for the agent pipeline (singleton).
	// The master on/off is the `ai.agent` feature flag — not a column here.
	agentConfig: defineTable({
		// Auto-reply settings
		isAutoReplyEnabled: v.boolean(),
		confidenceThreshold: v.number(), // 0-1, minimum confidence for auto-approval
		// Organization communication style
		toneDescription: v.optional(v.string()),
		signatureTemplate: v.optional(v.string()),
		// Rate limiting
		maxDailyAutoReplies: v.optional(v.number()),
		dailyAutoReplyCount: v.optional(v.number()),
		dailyAutoReplyResetAt: v.optional(v.number()),
		// Message coalescing debounce window. Opt-in: a positive value enables
		// burst coalescing (suggested 30000 = 30s); unset/0 processes each
		// message immediately. See agent/coalescing.ts.
		coalesceWindowMs: v.optional(v.number()),
		// Undo / send-delay window (ms) applied to AUTONOMOUS auto-sends only.
		// The auto-approved reply is scheduled after this delay instead of
		// firing immediately, recording a cancellable pending-send marker so a
		// landing customer reply, the kill switch, or an explicit user "Undo"
		// can abort it before it goes out. Unset ⇒ DEFAULT_AUTO_SEND_DELAY_MS
		// (60s). 0 preserves the legacy immediate-send behaviour. Human-reviewed
		// approvals are unaffected. See inbox/processingLifecycle/effects.ts.
		autoSendDelayMs: v.optional(v.number()),
		// Abandoned-clarification window (ms). A message parked in
		// `awaiting_clarification` for longer than this with no owner answer is
		// resumed by the fallback cron as a flagged best-guess that is never
		// auto-send-eligible. Unset ⇒ DEFAULT_CLARIFICATION_TIMEOUT_MS (24h). See
		// inbox/processingLifecycle.ts:reconcileAbandonedClarifications.
		clarificationTimeoutMs: v.optional(v.number()),
		// Shadow ("would-have-sent") mode. When true (or unset — shadow is the
		// DEFAULT posture before any real auto-send is trusted for a slice), the
		// `route` step computes the auto-send decision EXACTLY as normal but never
		// sends: an auto-approve is logged as a shadow "would-have-sent"
		// observation (agent/shadowScorecard.ts) and the message is routed to
		// human review instead. Set explicitly to `false` to let trusted slices
		// auto-send for real. Zero send-side risk while on. See
		// agent/steps/route/index.ts.
		isShadowMode: v.optional(v.boolean()),
		// Timezone-aware WORKING-HOURS window for AUTONOMOUS auto-sends. When
		// `isWorkingHoursEnabled` is true, an auto-approved reply whose routing
		// decision lands OUTSIDE the window is held for human review instead of
		// sent (the draft is still queued) — so the agent never fires at 3am and
		// out-of-hours replies wait for morning review. Times are minutes from
		// local midnight in `workingHoursTimezone` (an IANA zone); `workingHoursDays`
		// are the allowed weekdays (0=Sun … 6=Sat). Unset fields fall back to the
		// Mon–Fri 09:00–17:00 UTC default. Human-reviewed approvals are unaffected.
		// See lib/workingHours.ts + agent/steps/route/index.ts.
		isWorkingHoursEnabled: v.optional(v.boolean()),
		workingHoursTimezone: v.optional(v.string()),
		workingHoursStart: v.optional(v.number()),
		workingHoursEnd: v.optional(v.number()),
		workingHoursDays: v.optional(v.array(v.number())),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	// Agent Circuit Breakers - automated safety mechanisms
	agentCircuitBreakers: defineTable({
		breakerType: v.union(
			v.literal('llm_failure'),
			v.literal('confidence_degradation'),
			v.literal('rejection_spike')
		),
		state: v.union(
			v.literal('closed'), // Normal operation
			v.literal('open'), // Tripped, blocking auto-responses
			v.literal('half_open') // Testing recovery
		),
		threshold: v.number(),
		currentValue: v.number(),
		trippedAt: v.optional(v.number()),
		recoveredAt: v.optional(v.number()),
		createdAt: v.number(),
	}).index('by_breaker_type', ['breakerType']),

	// Autonomy Rules - auto-approval configuration, scoped by the optional
	// `sender`: ABSENT = the CATEGORY rule; PRESENT = a PER-SENDER/per-contact rule
	// for that exact normalized email, which the `route` step reads first and which
	// overrides the category rule (an `isEnabled: false` per-sender rule is an
	// explicit "never auto-send this sender" opt-out). `warmupRequired` is the
	// first-N-observed warm-up: a (category, sender) slice may auto-send only once
	// it has this many MATCHED shadow observations (see agentShadowScorecard;
	// absent → WARMUP_MATCHES_DEFAULT). A new sender with no scorecard row is
	// hard-excluded from auto-send regardless of any rule.
	autonomyRules: defineTable({
		category: v.string(), // "support", "sales", "billing", etc.
		sender: v.optional(v.string()), // per-sender/per-contact rule; absent on a category rule
		autoApproveThreshold: v.number(), // Confidence threshold (0-1)
		maxDailyAutoActions: v.number(), // Safety cap
		warmupRequired: v.optional(v.number()), // matched shadow obs before this slice may auto-send
		currentDailyCount: v.optional(v.number()),
		dailyCountResetAt: v.optional(v.number()),
		isEnabled: v.boolean(),
		// Auto-demotion incident (post-send-outcome-feedback). When a confirmed
		// BAD auto-send outcome (angry reply / bounce / complaint) lands on a
		// (category, sender) slice, that slice is auto-DEMOTED to draft-only:
		// `isEnabled` is forced false and these fields record the incident so the
		// autonomy UI can surface it as a first-class alert. `demotionAcknowledgedAt`
		// is set when the operator dismisses the alert. See autonomyOutcome.ts.
		autoDemotedAt: v.optional(v.number()),
		autoDemotedReason: v.optional(v.string()),
		autoDemotedSignal: v.optional(v.string()),
		demotionAcknowledgedAt: v.optional(v.number()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_category', ['category'])
		.index('by_sender_category', ['sender', 'category']),

	// Autonomy Feedback - tracks correction/outcome signals for threshold
	// adjustment. Two sources feed the SAME calibration loop:
	//   - `human`  : a reviewer's approve / reject / edit on the review queue.
	//   - `outcome`: a real-world post-send outcome on an AUTO-sent reply
	//     (an angry reply, a bounce, a complaint → negative; an owner sending
	//     an answered-clarification draft unedited → positive). Without this,
	//     the more the agent auto-sends the LESS signal the loop gets, because
	//     only the shrinking human-reviewed subset was ever measured.
	// The `action` mapping keeps the downstream cron/circuit-breaker readers
	// unchanged: a negative outcome maps to `rejected`, a positive to
	// `approved`. `source`/`outcomeSignal` are optional provenance — absent
	// rows are legacy human feedback.
	autonomyFeedback: defineTable({
		ruleId: v.optional(v.id('autonomyRules')),
		category: v.string(),
		action: v.union(v.literal('approved'), v.literal('rejected'), v.literal('edited')),
		agentConfidence: v.number(),
		userFeedback: v.optional(v.string()),
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// Provenance. Absent (or 'human') = a reviewer decision; 'outcome' = a
		// real-world post-send outcome captured by agent/outcomeFeedback.
		source: v.optional(v.union(v.literal('human'), v.literal('outcome'))),
		// For `source: 'outcome'` rows, which real-world signal produced it:
		// 'reply_negative' | 'bounce' | 'complaint' | 'clarification_unedited_send'.
		outcomeSignal: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index('by_category', ['category'])
		.index('by_created_at', ['createdAt']),

	// Autonomy Suggestions - pending "graduation" nudges. Autonomy only ever
	// widens (a lower auto-approve threshold = easier auto-send) by the user's
	// explicit decision, never automatically. When the weekly cron observes a
	// low rejection rate it records a suggestion here instead of loosening the
	// threshold itself; an owner/admin must explicitly accept it to apply.
	autonomySuggestions: defineTable({
		category: v.string(),
		currentThreshold: v.number(), // rule threshold at suggestion time
		suggestedThreshold: v.number(), // the looser (lower) threshold on offer
		evidence: v.object({
			approved: v.number(), // approvals observed in the window
			sampleSize: v.number(), // total feedback rows in the window
			rejectionRate: v.number(), // rejections / sampleSize
		}),
		createdAt: v.number(),
	}).index('by_category', ['category']),

	// Agent Shadow Decisions - one row per message observed while shadow
	// ("would-have-sent") mode is on. Records what the `route` step WOULD have
	// done (auto-send vs hold), the draft snapshot at decision time, and — once
	// the human acts on the review queue — how the shadowed decision compared to
	// the human outcome. Feeds the per-category/per-sender graduation scorecard.
	// Never influences routing; the message always goes to human review while
	// shadow is on. See agent/shadowScorecard.ts.
	agentShadowDecisions: defineTable({
		inboundMessageId: v.id('inboundMessages'),
		category: v.string(),
		sender: v.string(), // normalized sender email (slice key)
		isWouldHaveSent: v.boolean(), // route would have auto-approved
		reason: v.string(), // the route decision's rationale
		confidence: v.number(),
		draftQualityScore: v.optional(v.number()),
		shadowDraft: v.string(), // draft snapshot at decision time
		isResolved: v.boolean(), // reconciled against a human action yet?
		userAction: v.optional(
			v.union(v.literal('approved'), v.literal('rejected'), v.literal('edited'))
		),
		isMatched: v.optional(v.boolean()), // would-have-sent AND human approved unedited
		similarity: v.optional(v.number()), // shadowDraft vs. final human draft
		createdAt: v.number(),
		resolvedAt: v.optional(v.number()),
	})
		.index('by_message', ['inboundMessageId'])
		.index('by_category', ['category'])
		.index('by_sender', ['sender']),

	// Agent Shadow Scorecard - running per-(category, sender) aggregate of the
	// shadow observations above. `matched` counts the cases where the shadowed
	// decision would have auto-sent AND the human approved that exact draft
	// unedited. A slice whose matched/wouldHaveSent rate clears the graduation
	// thresholds surfaces an OFFER to enable auto-send — which still requires the
	// user's explicit acceptance (autonomySuggestions). See agent/shadowScorecard.ts.
	agentShadowScorecard: defineTable({
		category: v.string(),
		sender: v.string(),
		samples: v.number(), // total reconciled shadow observations for the slice
		wouldHaveSent: v.number(), // observations where route would have auto-sent
		matched: v.number(), // wouldHaveSent AND human approved the same draft unedited
		lastActivityAt: v.number(),
	})
		.index('by_category', ['category'])
		.index('by_category_sender', ['category', 'sender']),

	// Natural-language handling rules — plain-English standing intent the user
	// teaches the assistant ("always decline cold pitches", "flag anything from
	// legal for me"). The prose is TRUSTED (user-authored); a cheap LLM compiles
	// it ONCE into a deterministic `{ matcher, action }` (mail/handlingRulesCompile.ts).
	// The matcher runs at classify time with NO model in the loop, so the
	// untrusted inbound body never reaches an LLM through a rule. Actions can only
	// ever RESTRICT auto-send (draft-only / never-auto-send / always-ask /
	// auto-archive) or force a category — never widen auto-send. Single-org
	// deployment: rules are deployment-global, like autonomyRules. Inspectable +
	// editable + revocable in settings.
	handlingRules: defineTable({
		instruction: v.string(), // the user-authored prose (trusted)
		isEnabled: v.boolean(),
		matcher: v.object({
			senders: v.optional(v.array(v.string())),
			subjectContains: v.optional(v.array(v.string())),
			bodyContains: v.optional(v.array(v.string())),
			categories: v.optional(v.array(v.string())),
		}),
		action: v.object({
			type: v.union(
				v.literal('draft_with_stance'),
				v.literal('categorize'),
				v.literal('auto_archive'),
				v.literal('always_ask'),
				v.literal('never_auto_send')
			),
			stance: v.optional(v.string()),
			category: v.optional(v.string()),
		}),
		// Provenance for the settings UI ("compiled by <model>").
		compiledModel: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_enabled', ['isEnabled']),
};
