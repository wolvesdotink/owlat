/**
 * The Yahoo CFL liveness observation that rides on the complaint webhook path.
 *
 * Its own module rather than a function inside `dispatcher.ts`: the dispatcher is
 * a routing TABLE, and this is the one handler step that needs a policy docblock
 * of its own (CONVENTIONS.md — split a feature file rather than growing it).
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { logWarn } from '../lib/runtimeLog';
import type { InboundEventOf } from './types';

/**
 * Keep a DKIM-domain-based feedback-loop enrollment (Yahoo's CFL) marked live.
 *
 * A pure OBSERVATION of the report the shipped ARF processor already parsed —
 * one complaint pipeline, three sources, never a second parser. Three properties
 * make it safe to run on the complaint path:
 *
 *  - it runs AFTER suppression, so a slow or failing observation cannot delay a
 *    complaint reaching the blocklist;
 *  - it CANNOT throw. `observeReport` resolves the singleton organization, which
 *    rejects when a deployment has zero or several organizations, and any write
 *    can conflict; either would otherwise abort the whole complaint dispatch and
 *    cost us the complaint. A failure is logged and swallowed;
 *  - PRODUCTION ONLY. Member-preview mail is deliberately excluded from every
 *    measurement counter (`applyFeedbackProvenancePolicy` in the MTA), so preview
 *    traffic must never mark an enrollment live or hold confidence at `high`.
 *
 * It also CANNOT create an enrollment. Every fact reachable here is
 * report-supplied, so `applyYahooCflEvent` refuses a report against a
 * `not_started` domain: the observation confirms and refreshes an enrollment the
 * operator started, and nothing else.
 */
export async function observeYahooCflReport(
	ctx: ActionCtx,
	e: InboundEventOf<'email.complained'>
): Promise<void> {
	if (e.sourceIsp !== 'yahoo' || !e.reportedDomain || e.deliveryDomain !== 'production') return;
	try {
		await ctx.runMutation(internal.domains.yahooCfl.observeReport, {
			reportedDomain: e.reportedDomain,
			at: e.at,
		});
	} catch (error) {
		logWarn(
			`[Webhook Dispatcher] yahoo CFL enrollment observation failed for ` +
				`${e.reportedDomain}: ${error instanceof Error ? error.message : String(error)}. ` +
				`The complaint itself was already processed; only the liveness bookkeeping was skipped.`
		);
	}
}
