/**
 * Tier-1 agent-pipeline contribution (`agentSteps`).
 *
 * The manifest anchors this step `after: 'draft'`, which the host resolves to the
 * `after_draft` placement — the only placement whose approved lifecycle edges
 * include `draft_review: drafting -> draft_ready`. That is the single edge this
 * step declares and the single edge it ever requests at runtime.
 *
 * The contract is RESTRICT-ONLY:
 *   - `continue` lets the host proceed exactly as it would have without us;
 *   - `caution` can only route the reply to `draft_ready` (a human reviews it).
 * There is no result value that sends, approves, or skips a core step, and the
 * host independently re-checks the requested edge against the declared set, so a
 * bug here can only cost a human review, never an unreviewed autonomous send.
 */

import type {
	JsonObject,
	PluginAgentStepInput,
	PluginAgentStepModule,
	PluginAgentStepResult,
} from '@owlat/plugin-kit';
import { detectEscalation, summarizeVerdict, type EscalationVerdict } from './detector';

/** Local id of the step; the host namespaces it as `plugin.escalation-guard.<id>`. */
export const ESCALATION_STEP_LOCAL_ID = 'escalation-check';

/** Maximum length of the reason string handed back to the host. */
export const ESCALATION_REASON_MAX_LENGTH = 200;

export interface EscalationStepConfig {
	/**
	 * Severity at which the draft is held for review. Defaults to `escalate`, so
	 * only unambiguous signals (legal, regulator, chargeback) cost a human review
	 * while `watch` signals are merely recorded as step output.
	 */
	readonly minimumLevel?: 'watch' | 'escalate';
}

/** Structured, content-free step output: the verdict level and the signal ids. */
function stepOutput(verdict: EscalationVerdict): JsonObject {
	return {
		level: verdict.level,
		signals: verdict.signals.map((signal) => signal.id),
	};
}

export function createEscalationAgentStep(
	config: EscalationStepConfig = {}
): PluginAgentStepModule {
	const minimumLevel = config.minimumLevel ?? 'escalate';

	return {
		async execute(input: PluginAgentStepInput): Promise<PluginAgentStepResult> {
			const verdict = detectEscalation({
				subject: input.subject,
				textBody: input.textBody,
				htmlBody: input.htmlBody,
			});

			const holds =
				minimumLevel === 'watch' ? verdict.level !== 'none' : verdict.level === 'escalate';
			if (!holds) return { kind: 'continue', output: stepOutput(verdict) };

			return {
				kind: 'caution',
				// The ONLY caution target this step ever names, and the only one its
				// manifest declares for the `after_draft` placement.
				to: 'draft_ready',
				reason: summarizeVerdict(verdict).slice(0, ESCALATION_REASON_MAX_LENGTH),
				output: stepOutput(verdict),
			};
		},
	};
}

/** The bundled step the manifest points at. */
export const escalationAgentStep: PluginAgentStepModule = createEscalationAgentStep();
