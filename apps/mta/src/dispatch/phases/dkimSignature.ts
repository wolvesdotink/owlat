/**
 * Phase: a send that is owed a DKIM signature waits until one can be made.
 *
 * Convex marks a send `requireDkimSignature` when its From domain is a sending
 * domain registered with this MTA. Shipping such a message unsigned is not a
 * fallback: the domain's DMARC policy and Gmail's and Yahoo's bulk-sender rules
 * reject it (5.7.26), so a lost Redis volume, a changed `MTA_SECRET` or a
 * corrupt key would bounce a whole campaign. The message is deferred instead,
 * and delivers signed once the key is back, bounded by the message's age limit.
 *
 * The hold is about our sending identity, never the recipient: it defers with
 * `bounceCause: 'sender'`, so an expiry does not count against the address.
 * Runs before IP selection and the org limit so a held message spends no
 * capacity while it waits.
 *
 * The compose step re-resolves the key and refuses to sign without it as well
 * (`smtp/send/compose.ts`); this phase is what keeps the common case cheap.
 */

import { resolveRequiredDkimKey } from '../../smtp/dkim.js';
import {
	DKIM_HOLD_RETRY_DELAY_MS,
	clearDkimSigningHold,
	recordDkimSigningHold,
} from '../../smtp/dkimSigningHold.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const dkimSignaturePhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'dkim_signature',
	async run(deps, ctx) {
		if (ctx.job.requireDkimSignature !== true) return { kind: 'continue', ctx };
		const domain = ctx.job.dkimDomain.toLowerCase();
		const resolved = await resolveRequiredDkimKey(deps.redis, domain, ctx.job.organizationId);
		if (resolved.kind === 'key') {
			await clearDkimSigningHold(deps.redis, domain);
			return { kind: 'continue', ctx };
		}
		await recordDkimSigningHold(deps.redis, domain, resolved.cause);
		return {
			kind: 'defer',
			delayMs: DKIM_HOLD_RETRY_DELAY_MS,
			reason: dkimHoldReason(domain, resolved.cause),
			bounceCause: 'sender',
		};
	},
};

/** The defer reason a held send carries, shared with the compose-time hold. */
export function dkimHoldReason(domain: string, cause: string): string {
	return `DKIM signature required for ${domain} but unavailable (${cause})`;
}
