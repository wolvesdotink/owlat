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
 * The probe is NOT free — it deliberately manufactures a bounce on the
 * operator's relay account, and a relay's bounce rate is exactly what gets that
 * account suspended. So it is rate-limited by the backing-off retry schedule in
 * the pure core (24h → 7d → 30d), and it is only ever run for transports whose
 * catalog declaration is `probe`.
 *
 * Plan D2: the probe is additive. A relay that is not configured, a deployment
 * with no return-path domain or VERP key, a probe that fails on the wire — all
 * simply leave the capability `unknown`, which reads as unsupported + degraded
 * measurement. Nothing throws, nothing is blocked.
 */

import { randomUUID } from 'node:crypto';
import { v } from 'convex/values';
import { isUsableVerpKey, normalizeReturnPathDomain, normalizeVerpKey } from '@owlat/shared/verp';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { getOptional } from '../lib/env';
import { sendProviderCatalogEntry } from '../lib/sendProviders/catalog';
import { sendViaRelay } from '../lib/sendProviders/smtp';
import {
	listSendTransports,
	tryResolveSendTransport,
	type SendTransportRecord,
} from '../lib/sendProviders/transports';
import { returnPathProbeMessageId } from './messageIdRouting';

/**
 * Is this transport's return-path support decided by OBSERVATION rather than by
 * declaration? `yes` and `no` are settled by the catalog, so probing them would
 * prove nothing and would spend a real bounce doing it. One definition, because
 * the single-transport run and the sweep must agree on what is worth probing.
 */
function isProbeableTransport(transport: SendTransportRecord): boolean {
	return sendProviderCatalogEntry(transport.kind).supportsCustomReturnPath === 'probe';
}

/** Why a probe run did nothing. All benign — see the D2 note above. */
export type ReturnPathProbeSkipReason =
	| 'unresolvable_transport'
	| 'not_probeable'
	| 'not_configured'
	| 'not_due';

export type ReturnPathProbeRunResult =
	| { readonly ran: false; readonly reason: ReturnPathProbeSkipReason }
	| { readonly ran: true; readonly probeId: string; readonly accepted: boolean };

/**
 * Run one capability probe for one configured transport. Idempotent per
 * schedule: it no-ops unless the stored verdict is missing, stale or expired.
 */
export const runReturnPathProbe = internalAction({
	args: { transportId: v.string(), force: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<ReturnPathProbeRunResult> => {
		const transport = tryResolveSendTransport(args.transportId);
		if (!transport) return { ran: false, reason: 'unresolvable_transport' };
		if (!isProbeableTransport(transport)) return { ran: false, reason: 'not_probeable' };

		const returnPathDomain = normalizeReturnPathDomain(getOptional('MTA_RETURN_PATH_DOMAIN'));
		const verpKey = normalizeVerpKey(getOptional('MTA_BOUNCE_VERP_KEY'));
		// The probe's FROM identity must be one the relay is already verified for.
		// The return-path domain is NOT: its SPF authorises the MTA pool IPs, not
		// the relay's, and mainstream relays (SendGrid, Mailgun, Brevo, Postmark)
		// refuse an unverified From outright — which we would have recorded as
		// `rejected_by_relay` and held against the CAPABILITY, denying it for a
		// reason that has nothing to do with the envelope sender, on exactly the
		// ESP relays this feature exists to measure. `DEFAULT_FROM_EMAIL` is the
		// identity this deployment's real mail already leaves through, so it is
		// verified by construction. Only RFC5321.MailFrom stays experimental.
		const probeFrom = getOptional('DEFAULT_FROM_EMAIL')?.trim();
		// A key the MTA would reject at startup can never verify the token this
		// probe mints, so the DSN would arrive unattributable and the transport
		// would be graded unsupported for the wrong reason. Don't spend a bounce.
		if (!returnPathDomain || !isUsableVerpKey(verpKey) || !probeFrom) {
			return { ran: false, reason: 'not_configured' };
		}

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
		// A never-provisioned mailbox at our OWN bounce domain: the rejection comes
		// from our own MX, no human ever receives this message, and the DSN the
		// relay generates is the evidence.
		const probeRecipient = `return-path-probe-${probeId}@${returnPathDomain}`;
		let accepted = false;
		// Fall back to the address we ASKED for if the send never reached the wire;
		// a refusal is recorded as unsupported either way.
		let sentEnvelopeSender = probeFrom;
		try {
			// The adapter builds the VERP envelope sender with the SAME shipped
			// scheme a real send uses — there is exactly one VERP builder — and
			// hands back the address it actually put on the wire. Recomputing it
			// here would risk straddling the UTC VERP window boundary and recording
			// an address that differs from the one sent.
			const outcome = await sendViaRelay(
				transport,
				{
					to: probeRecipient,
					from: probeFrom,
					subject: 'Owlat return-path capability probe',
					html: '<p>Automated return-path capability probe. No action is required.</p>',
					text: 'Automated return-path capability probe. No action is required.',
					headers: { 'X-Owlat-Return-Path-Probe': probeId },
				},
				{ customReturnPath: true, verpMessageId: probeMessageId }
			);
			accepted = outcome.attempt.success;
			sentEnvelopeSender = outcome.envelopeSender;
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

/**
 * How many transports one hourly sweep may actually probe.
 *
 * The transport set is operator-controlled (`SEND_TRANSPORT_INSTANCES`), and
 * each probe is a REAL relay send bounded only by `SMTP_SEND_TIMEOUT_MS` (30s)
 * that deliberately manufactures a bounce. Unbounded, a deployment with a dozen
 * declared relays would serialise a dozen 30s network sends inside one action
 * and produce a dozen bounces in one burst — on accounts whose bounce rate is
 * exactly what gets them suspended. Two per tick drains any realistic transport
 * set within a few hours, and the per-transport backoff guarantees the queue
 * empties rather than cycling.
 */
const MAX_PROBES_PER_SWEEP = 2;

/**
 * Expire stale probes, then probe the configured transports that could support
 * a custom return path, at most {@link MAX_PROBES_PER_SWEEP} per tick — the
 * next hourly tick takes the rest.
 *
 * This is what makes the capability REACHABLE in production: without a caller,
 * no relay ever leaves `unknown`, the VERP stamp is never enabled and the relay
 * arm keeps producing no bounce data of its own. Runs on a cron AND is safe to
 * call from a transport-verification path, because `runReturnPathProbe` is
 * idempotent per schedule — a transport that is not due is a no-op.
 *
 * Expiry runs FIRST: a probe that just aged out is immediately re-probeable, so
 * one sweep both settles the verdict and schedules the next question.
 */
export const sweepReturnPathProbes = internalAction({
	args: {},
	handler: async (ctx): Promise<{ expired: number; probed: number }> => {
		const { expired } = await ctx.runMutation(
			internal.delivery.relayReturnPath.expireTimedOutProbes,
			{}
		);
		let probed = 0;
		for (const transport of listSendTransports()) {
			if (probed >= MAX_PROBES_PER_SWEEP) break;
			if (!isProbeableTransport(transport)) continue;
			const result: ReturnPathProbeRunResult = await ctx.runAction(
				internal.delivery.relayReturnPathProbe.runReturnPathProbe,
				{ transportId: transport.id }
			);
			if (result.ran) probed++;
		}
		return { expired, probed };
	},
});
