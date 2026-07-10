'use node';

/**
 * "Move my mailbox here" — Node-runtime surface (piece c5).
 *
 * The live inbound-MX check that backs the cutover stage. It reads the domain
 * being moved and this deployment's inbound MX host authoritatively from the
 * server (never a client-supplied value) via `mailboxMove.moveStatus`, resolves
 * the domain's MX records, and reports whether any of them points at us yet.
 *
 * NEVER throws: a DNS hiccup degrades to "not confirmed" so the cutover UI keeps
 * showing the current truth rather than breaking. The DB work stays in the v8
 * sibling `mailboxMove.ts`; only the `node:dns` lookup needs the Node runtime.
 */

import { api } from '../_generated/api';
import { authedAction } from '../lib/authedFunctions';
import dns from 'node:dns/promises';

/** A resolved inbound MX record for the domain being moved. */
type FoundMxRecord = { priority: number; exchange: string };

/** Structured verdict for the cutover DNS check. `null` = nothing to check. */
export type MoveMxCheckResult = {
	verified: boolean;
	expectedHost: string;
	records: FoundMxRecord[];
	checkedAt: number;
};

function normalizeHost(name: string): string {
	return name.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Live check of whether the moving domain's inbound MX points at this
 * deployment. Returns `null` when there's no move in cutover, or the deployment
 * has no inbound MX host configured (send-only install — nothing to point at).
 */
// authz: the delegated `moveStatus` query is self-scoped to the caller's own move.
export const checkCutoverMx = authedAction({
	args: {},
	handler: async (ctx): Promise<MoveMxCheckResult | null> => {
		const status = await ctx.runQuery(api.mail.mailboxMove.moveStatus, {});
		if (!status.eligible || !status.mxHost || status.move?.stage !== 'cutover_pending') {
			return null;
		}
		const expectedHost = normalizeHost(status.mxHost);
		const checkedAt = Date.now();
		try {
			const resolved = await dns.resolveMx(status.domain);
			const records: FoundMxRecord[] = resolved.map((mx) => ({
				priority: mx.priority,
				exchange: mx.exchange,
			}));
			const verified = records.some((mx) => normalizeHost(mx.exchange) === expectedHost);
			return { verified, expectedHost, records, checkedAt };
		} catch {
			// No MX yet / lookup error — degrade to "not confirmed".
			return { verified: false, expectedHost, records: [], checkedAt };
		}
	},
});
