'use node';

/**
 * Return-path capability PROBE — the network half of plan G-08's capability
 * detection. Kept apart from `relayReturnPath.ts` because a `'use node'` module
 * may hold only actions, and the persistence there is queries + mutations.
 *
 * What the probe does: send one real message THROUGH the relay, with our signed
 * VERP address as the envelope sender, to an address at our own bounce domain
 * that has no mailbox. The receiving side rejects it, the relay generates the
 * DSN — and the ONLY way that DSN reaches us is if the relay kept the envelope
 * sender we set. So the verdict comes from an observed delivered bounce
 * (recorded by the webhook dispatcher), never from the relay merely ACCEPTING
 * our MAIL FROM: a relay that accepts it and silently rewrites it is exactly
 * the deployment this gate exists to protect, and trusting acceptance would
 * hand it a false "comparable" flag.
 *
 * Plan D2: the probe is additive. A relay that is not configured, a deployment
 * with no return-path domain or VERP key, a probe that fails on the wire — all
 * simply leave the capability `unknown`, which reads as unsupported + degraded
 * measurement. Nothing throws, nothing is blocked.
 */

import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { getOptional } from '../lib/env';
import { sendProviderCatalogEntry } from '../lib/sendProviders/catalog';
import { resolveRelayEnvelopeSender, smtpSendProvider } from '../lib/sendProviders/smtp';
import {
	resolveSendTransport,
	type SendTransportId,
	type SendTransportRecord,
} from '../lib/sendProviders/transports';
import { returnPathProbeMessageId } from './relayReturnPath';

/** Why a probe run did nothing. All benign — see the D2 note above. */
export type ReturnPathProbeSkipReason =
	| 'unresolvable_transport'
	| 'not_probeable'
	| 'not_configured'
	| 'not_due';

export type ReturnPathProbeRunResult =
	| { readonly ran: false; readonly reason: ReturnPathProbeSkipReason }
	| { readonly ran: true; readonly probeId: string; readonly accepted: boolean };

function resolveTransport(transportId: string): SendTransportRecord | null {
	try {
		return resolveSendTransport(transportId as SendTransportId);
	} catch {
		return null;
	}
}

/**
 * Run one capability probe for one configured transport. Idempotent per
 * schedule: it no-ops unless the stored verdict is missing, stale or expired.
 */
export const runReturnPathProbe = internalAction({
	args: { transportId: v.string(), force: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<ReturnPathProbeRunResult> => {
		const transport = resolveTransport(args.transportId);
		if (!transport) return { ran: false, reason: 'unresolvable_transport' };
		if (sendProviderCatalogEntry(transport.kind).supportsCustomReturnPath !== 'probe') {
			// `yes` and `no` are settled by the catalog; probing would prove nothing.
			return { ran: false, reason: 'not_probeable' };
		}

		const returnPathDomain = getOptional('MTA_RETURN_PATH_DOMAIN')?.trim().replace(/\.$/, '');
		const verpKey = getOptional('MTA_BOUNCE_VERP_KEY')?.trim();
		if (!returnPathDomain || !verpKey) return { ran: false, reason: 'not_configured' };

		const at = Date.now();
		if (args.force !== true) {
			const due = await ctx.runQuery(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: args.transportId,
				at,
			});
			if (!due) return { ran: false, reason: 'not_due' };
		}

		const probeId = randomUUID();
		const probeMessageId = returnPathProbeMessageId(probeId);
		// The adapter builds the VERP envelope sender from this id with the SAME
		// shipped scheme a real send uses — there is exactly one VERP builder.
		const sentEnvelopeSender = resolveRelayEnvelopeSender({
			composedEnvelopeFrom: `postmaster@${returnPathDomain}`,
			messageId: probeMessageId,
			customReturnPath: true,
			returnPathDomain,
			verpKey,
			now: at,
		}).envelopeFrom;

		// A never-provisioned mailbox at our own bounce domain: the rejection is
		// the point, and no human ever receives this message.
		const probeRecipient = `return-path-probe-${probeId}@${returnPathDomain}`;
		let accepted = false;
		try {
			const attempt = await smtpSendProvider.sendEmail(
				transport,
				{
					to: probeRecipient,
					from: `postmaster@${returnPathDomain}`,
					subject: 'Owlat return-path capability probe',
					html: '<p>Automated return-path capability probe. No action is required.</p>',
					text: 'Automated return-path capability probe. No action is required.',
					headers: { 'X-Owlat-Return-Path-Probe': probeId },
				},
				{ customReturnPath: true, verpMessageId: probeMessageId }
			);
			accepted = attempt.success;
		} catch {
			// A probe that cannot even reach the relay is not an error state; it is
			// simply no evidence, recorded as a refusal so the retry interval applies.
			accepted = false;
		}

		await ctx.runMutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: args.transportId,
			probeId,
			sentEnvelopeSender,
			accepted,
			at,
		});
		return { ran: true, probeId, accepted };
	},
});
