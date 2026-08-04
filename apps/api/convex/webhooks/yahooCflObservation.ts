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
 *  - PRODUCTION ONLY, which is also how the ATTRIBUTION property is asserted.
 *    `deliveryDomain` has exactly ONE writer — `applyFeedbackProvenancePolicy` in
 *    `apps/mta/src/bounce/outcome.ts` — and it drops the entire effect list when
 *    the report's provenance is `unknown`. So a `production` delivery domain on a
 *    complaint event IS an exactly-VERP-attributed report, and member-preview mail
 *    (excluded from every measurement counter) is excluded here too. That coupling
 *    lives two apps away, so it is PINNED FROM BOTH ENDS rather than assumed: an
 *    unattributed complaint cannot reach this function
 *    (`webhooks/__tests__/dispatcher.test.ts`), and an `unknown`-provenance FBL
 *    attempt emits no event at all to carry one
 *    (`apps/mta/src/bounce/__tests__/yahooArf.test.ts`).
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
