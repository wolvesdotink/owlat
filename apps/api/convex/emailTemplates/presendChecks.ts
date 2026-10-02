/**
 * Pre-send checks, the server half: the bounds and the authorization floor for
 * `presendChecksActions.run`, the action the campaign Review step and the email
 * editor's "Check email" call for what a browser cannot find out itself
 * (whether links resolve, how heavy the images are, and the MTA's content
 * screening verdict). Every other check runs in the browser on the rendered
 * HTML (`apps/web/app/lib/presendChecks/`).
 *
 * The checks only report: nothing here blocks or records a send.
 */

import { internalQuery } from '../_generated/server';
import { requireOrgPermission } from '../lib/sessionOrganization';

/** Links probed per run; the web collects them deduplicated and in document order. */
export const PRESEND_MAX_LINKS = 200;
/** Images probed per run. */
export const PRESEND_MAX_IMAGES = 100;
/** Longest URL accepted; a longer one is reported as not checked. */
export const PRESEND_MAX_URL_CHARS = 2048;

/** Campaign senders an org can have; mirrors the `senders.ts` cap. */
const MAX_SENDERS_SCANNED = 200;

/**
 * The floor for a pre-send run, plus what the run needs from the database: the
 * caller's id (the rate-limit key) and the org's default campaign sender, which
 * the content screening scores the message from when the caller has no sender
 * yet (the email editor).
 *
 * `campaigns:manage`: the people who build and send campaigns. The probes make
 * outbound requests, so a member without that capability cannot start them.
 */
export const authorize = internalQuery({
	args: {},
	handler: async (ctx): Promise<{ userId: string; defaultFromEmail: string | null }> => {
		const session = await requireOrgPermission(ctx, 'campaigns:manage');
		const senders = await ctx.db.query('campaignSenders').take(MAX_SENDERS_SCANNED);
		const fallback = senders.find((sender) => sender.isDefault && sender.isEnabled);
		return { userId: session.userId, defaultFromEmail: fallback?.email ?? null };
	},
});
