'use node';

/**
 * "Move my mailbox here" — Node-runtime surface (piece c5).
 *
 * The live inbound-MX check that backs the cutover stage. It reads the domain
 * being moved and this deployment's inbound MX host authoritatively from the
 * server (never a client-supplied value) via `mailboxMove.moveStatus`, then
 * reuses the shared `domains/dnsVerification.verifyMxRecord` helper — the same
 * resolveMx + trailing-dot/lowercase normalization + exchange matching the
 * delivery/domains DNS checks use — to report whether the domain points here yet.
 *
 * NEVER throws: `verifyMxRecord` folds a DNS hiccup into a "not verified" result
 * so the cutover UI keeps showing the current truth rather than breaking. The DB
 * work stays in the v8 sibling `mailboxMove.ts`.
 */

import { api } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import { verifyMxRecord } from '../domains/dnsVerification';

/**
 * Live check of whether the moving domain's inbound MX points at this
 * deployment. Returns `null` when there's no move in cutover, or the deployment
 * has no inbound MX host configured (send-only install — nothing to point at).
 */
// authz: the delegated `moveStatus` query is self-scoped to the caller's own move.
export const checkCutoverMx = authedAction({
	args: {},
	handler: async (ctx): Promise<{ verified: boolean; checkedAt: number } | null> => {
		const status = await ctx.runQuery(api.mail.mailboxMove.moveStatus, {});
		if (!status.eligible || !status.mxHost || status.move?.stage !== 'cutover_pending') {
			return null;
		}
		// Exchange-only match (no priority): the user may publish any priority.
		const result = await verifyMxRecord(status.domain, status.mxHost);
		return { verified: result.verified, checkedAt: result.lastChecked };
	},
});
