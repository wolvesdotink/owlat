/**
 * Tier-1 restrict-only send gate.
 *
 * This is the plugin's `sendGates` contribution: a `PluginAutonomyGateModule`
 * the host runs before an autonomous send. It composes all three tiers of the
 * plugin's judgement:
 *   - Tier 1 (in-process): the deterministic engine analyzes the draft; a `fail`
 *     verdict raises an objection.
 *   - Tier 2 (connected hook): an OPTIONAL seedbox score can only ESCALATE — a
 *     high remote score adds an objection, and its absence/timeout/failure falls
 *     back to the local score (see `scoreDeliverability`).
 *
 * The contract is RESTRICT-ONLY and FAIL-CLOSED by construction:
 *   - the only results are `no-objection` and `objection` — there is no value it
 *     can return that approves, unblocks, or forces a send;
 *   - any thrown error inside `evaluate` becomes an objection, so a bug or a
 *     hostile dependency can only ever make Owlat MORE cautious, never less.
 */

import { analyzeEmail, summarizeFailure } from './engine';
import type { DeliverabilityEmail } from './engine';
import { scoreDeliverability, type RemoteScoreHook } from './remoteScore';
import type {
	PluginAutonomyGateInput,
	PluginAutonomyGateModule,
	PluginAutonomyGateResult,
	PluginAutonomyGateServices,
} from '@owlat/plugin-kit';

/** A remote score at or above this escalates an otherwise-clean draft to a hold. */
export const REMOTE_SCORE_FAIL_THRESHOLD = 0.8;

/** Default wall-clock budget for the optional seedbox call, well under the gate timeout. */
export const DEFAULT_REMOTE_DEADLINE_MS = 5_000;

export interface DeliverabilityGateConfig {
	/** Optional Tier-2 seedbox hook. When absent the gate is purely in-process. */
	readonly remoteScoreHook?: RemoteScoreHook;
	readonly remoteDeadlineMs?: number;
	readonly remoteFailThreshold?: number;
}

/** Treat a body that contains a tag as HTML so the link/accessibility checks run. */
function toEmail(input: PluginAutonomyGateInput): DeliverabilityEmail {
	const looksLikeHtml = /<[a-z!/][\s\S]*>/i.test(input.draftBody);
	return {
		from: input.from,
		subject: input.subject,
		html: looksLikeHtml ? input.draftBody : undefined,
		text: looksLikeHtml ? undefined : input.draftBody,
	};
}

/**
 * Build a send gate. The default export ships with no remote hook (pure Tier-1);
 * pass `remoteScoreHook` to compose the Tier-2 seedbox opinion. Either way the
 * result can only restrict.
 */
export function createDeliverabilityGate(
	config: DeliverabilityGateConfig = {}
): PluginAutonomyGateModule {
	const remoteFailThreshold = config.remoteFailThreshold ?? REMOTE_SCORE_FAIL_THRESHOLD;
	const remoteDeadlineMs = config.remoteDeadlineMs ?? DEFAULT_REMOTE_DEADLINE_MS;

	return {
		async evaluate(
			input: PluginAutonomyGateInput,
			services: PluginAutonomyGateServices
		): Promise<PluginAutonomyGateResult> {
			try {
				const email = toEmail(input);
				const report = analyzeEmail(email);

				// Tier-1: a disqualifying local verdict holds the send outright.
				if (report.overall === 'fail') {
					return { outcome: 'objection', reason: summarizeFailure(report) };
				}

				// Tier-2: an optional vendor opinion can only make us more cautious.
				const remote = await scoreDeliverability(email, {
					hook: config.remoteScoreHook,
					deadlineMs: remoteDeadlineMs,
					signal: services.signal,
				});
				if (remote.source === 'remote' && remote.score >= remoteFailThreshold) {
					const detail = remote.reason ? ` ${remote.reason}` : '';
					return {
						outcome: 'objection',
						reason: `Seedbox flagged this draft as likely spam (score ${remote.score.toFixed(
							2
						)}).${detail}`,
					};
				}

				return { outcome: 'no-objection' };
			} catch {
				// FAIL CLOSED: any unexpected error becomes a hold, never an approval.
				return {
					outcome: 'objection',
					reason: 'Deliverability Lab could not complete its pre-send checks; holding for review.',
				};
			}
		},
	};
}

/** The bundled, self-contained gate the manifest points at (pure Tier-1). */
export const deliverabilityGate: PluginAutonomyGateModule = createDeliverabilityGate();
