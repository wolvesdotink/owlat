/**
 * Bounce outcome — pure reducer for the post-classification effect emission.
 *
 * Mirrors `apps/mta/src/dispatch/outcome.ts` (ADR-0007) shape: typed
 * classification + typed effect list + runner. The reducer has no side
 * effects, no Redis dependency, and no HTTP dependency — it consumes the
 * `BounceAttempt` produced by the pipeline + the original `BasePhaseCtx`
 * (parsed mail, raw bytes, rcptTo) and returns a list of `BounceEffect`s.
 *
 * See ADR-0007 follow-up #4 and CONTEXT.md's MTA dispatch section.
 */

import type { BounceEffect } from './effects.js';
import type { BasePhaseCtx, BounceAttempt } from './types.js';

/**
 * The reducer's return type. `effects` runs through `applyEffects` in the
 * runner. Unlike the Dispatch reducer there is no `defer` field — the
 * bounce SMTP server doesn't re-queue messages; it always ACKs.
 */
export interface OutcomeReduction {
	effects: BounceEffect[];
}

/**
 * Pure reducer — given a Bounce attempt classification and the attempt's
 * ctx, returns the effects to apply.
 *
 * Tests assert against the returned data structure — no mocking of Redis,
 * metrics, logger, or fetch is required to verify the reducer's correctness.
 */
export function reduce(attempt: BounceAttempt, ctx: BasePhaseCtx): OutcomeReduction {
	switch (attempt.kind) {
		case 'fbl':
			return reduceFbl(attempt);
		case 'dsn_attributed':
			return reduceDsnAttributed(attempt);
		case 'dsn_unattributed':
			return reduceDsnUnattributed();
		case 'mailbox':
			return reduceMailbox(attempt, ctx);
		case 'endpoint_forward':
			return reduceEndpointForward(attempt, ctx);
		case 'inbound_accept':
			return reduceInboundAccept(attempt, ctx);
		case 'route_hold':
		case 'route_bounce':
		case 'unrecognized':
			return { effects: [] };
	}
}

function reduceFbl(attempt: Extract<BounceAttempt, { kind: 'fbl' }>): OutcomeReduction {
	const { arf } = attempt;
	const sourceIsp = arf.message?.match(/from (\w+)/)?.[1] ?? 'unknown';
	const effects: BounceEffect[] = [];

	if (arf.organizationId) {
		effects.push({
			kind: 'circuit_breaker_outcome',
			orgId: arf.organizationId,
			outcome: 'complained',
		});
	}

	effects.push({
		kind: 'metric_inc',
		metric: 'fbl_complaint',
		isp: sourceIsp,
		attributed: arf.originalMessageId ? 'yes' : 'no',
	});

	// Per-campaign attribution (from the original message's `Feedback-ID`). This
	// runs independently of org attribution: a complaint that carries a campaign
	// id but no org id used to fall through to only the flat `total` counter and
	// never enter any rate window. Now it gets its own per-campaign counter AND
	// is rate-tracked (the record effect alerts on crossing 0.3%).
	if (arf.campaignId) {
		effects.push({
			kind: 'metric_inc',
			metric: 'fbl_complaint_by_campaign',
			campaign: arf.campaignId,
			isp: sourceIsp,
		});
		effects.push({
			kind: 'campaign_complaint_record',
			campaignId: arf.campaignId,
			organizationId: arf.organizationId,
		});
	}

	// Surface the complaint to Convex when we have ANY attribution handle.
	// Preferred: the original Message-ID (attributes to the exact send).
	// Fallback (RFC 5965 §3.2): the complained recipient address, used to
	// suppress by email when the Message-ID is redacted (e.g. Gmail FBL).
	// Without this fallback a redacted complaint would only bump a metric and
	// never reach the blocklist/reputation path — silently inflating the
	// complaint rate past the Gmail <0.3% threshold.
	if (arf.originalMessageId || arf.recipient) {
		effects.push({
			kind: 'notify_convex',
			event: {
				event: 'complained',
				...(arf.originalMessageId ? { messageId: arf.originalMessageId } : {}),
				...(arf.recipient ? { recipient: arf.recipient } : {}),
				organizationId: arf.organizationId,
				message: arf.message,
				timestamp: Date.now(),
			},
		});
	}

	effects.push({ kind: 'fbl_stats_record' });

	return { effects };
}

function reduceDsnAttributed(
	attempt: Extract<BounceAttempt, { kind: 'dsn_attributed' }>
): OutcomeReduction {
	const { bounce } = attempt;
	return {
		effects: [
			{
				kind: 'notify_convex',
				event: {
					event: 'bounced',
					messageId: bounce.originalMessageId,
					organizationId: bounce.organizationId,
					bounceType: bounce.bounceType,
					message: bounce.message,
					timestamp: Date.now(),
				},
			},
		],
	};
}

function reduceDsnUnattributed(): OutcomeReduction {
	return {
		effects: [{ kind: 'metric_inc', metric: 'unattributed_bounce' }],
	};
}

function reduceMailbox(
	attempt: Extract<BounceAttempt, { kind: 'mailbox' }>,
	ctx: BasePhaseCtx
): OutcomeReduction {
	const { parsed, rawBuffer, spfResult, envelopeFromDomain, dkimSigningDomain, returnPath } = ctx;
	const {
		mailbox,
		rcptTo,
		attachments,
		toAddrs,
		ccAddrs,
		bccAddrs,
		references,
		dkimResult,
		dmarcResult,
		dmarcPolicy,
		arcCv,
		arcSealerDomain,
		arcAttestsOriginalPass,
	} = attempt;

	const deliveryId = `mb-${parsed.messageId ?? Date.now()}-${rcptTo}`;

	return {
		effects: [
			{
				kind: 'notify_convex',
				event: {
					event: 'inbound.mailbox.received',
					messageId: parsed.messageId,
					organizationId: mailbox.organizationId,
					message: `Postbox delivery from ${parsed.from?.text} to ${rcptTo}`,
					mailboxPayload: {
						deliveryId,
						recipientAddress: rcptTo,
						rawBytesBase64: rawBuffer.toString('base64'),
						from: parsed.from?.text ?? '',
						to: [...toAddrs],
						cc: [...ccAddrs],
						bcc: [...bccAddrs],
						replyTo: parsed.replyTo?.value?.[0]?.address,
						// SMTP envelope sender (RFC 5321 MAIL FROM). `''` for the
						// null sender (`<>`) of a DSN/bounce — the Convex vacation
						// hook keys its RFC 3834 §2 anti-backscatter skip off this,
						// not the spoofable `From:` header.
						returnPath: returnPath ?? '',
						subject: parsed.subject ?? '(no subject)',
						textBody: parsed.text ?? undefined,
						htmlBody: parsed.html !== false ? (parsed.html ?? undefined) : undefined,
						messageId: parsed.messageId ?? deliveryId,
						inReplyTo: parsed.inReplyTo?.replace(/[<>]/g, '') ?? undefined,
						references,
						date: parsed.date ? parsed.date.getTime() : undefined,
						dkimResult,
						dmarcResult,
						dmarcPolicy,
						// Verified ARC verdict (RFC 8617, Sealed Mail A5). Convex applies
						// the trusted-forwarder override against its editable allow-list —
						// the MTA only reports the cryptographic verdict.
						arcCv,
						arcSealerDomain,
						arcAttestsOriginalPass,
						attachments: attachments.map((att) => ({
							filename: att.filename,
							contentType: att.contentType,
							size: att.size,
							contentId: att.contentId,
							partIndex: att.partIndex,
						})),
						// RFC 8601 auth verdict. SPF (`onMailFrom`, threaded via the
						// session → ctx), DKIM, and DMARC (both in `onData` over the
						// raw bytes — see `dkimResult` / `dmarcResult` above) are all
						// computed inbound here. ARC / spam / virus are still left
						// undefined (not verified inbound yet) rather than trusting an
						// attacker-suppliable Authentication-Results header; Convex
						// stores whatever is present and routes spam verdicts to the
						// Spam folder.
						spfResult,
						// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d=
						// domain), stored beside the verdicts on `mailMessages` so a
						// later impersonation heuristic need not re-parse the .eml.
						envelopeFromDomain,
						dkimSigningDomain,
					},
					timestamp: Date.now(),
				},
			},
			{
				kind: 'mailbox_quota_bump',
				address: rcptTo,
				deltaBytes: rawBuffer.length,
			},
		],
	};
}

function reduceEndpointForward(
	attempt: Extract<BounceAttempt, { kind: 'endpoint_forward' }>,
	ctx: BasePhaseCtx
): OutcomeReduction {
	return {
		effects: [
			{
				kind: 'forward_to_endpoint',
				route: attempt.route,
				parsed: ctx.parsed,
				rcptTo: attempt.rcptTo,
				// RFC 8601 inbound auth verdicts + DMARC alignment inputs, threaded
				// to the external endpoint's webhook payload beside the message so a
				// downstream consumer can show an honest sender badge. All optional.
				auth: {
					spfResult: ctx.spfResult,
					dkimResult: ctx.dkimResult,
					dmarcResult: ctx.dmarcResult,
					dmarcPolicy: ctx.dmarcPolicy,
					envelopeFromDomain: ctx.envelopeFromDomain,
					dkimSigningDomain: ctx.dkimSigningDomain,
				},
			},
		],
	};
}

function reduceInboundAccept(
	attempt: Extract<BounceAttempt, { kind: 'inbound_accept' }>,
	ctx: BasePhaseCtx
): OutcomeReduction {
	const { parsed, spfResult, dkimResult, dmarcResult, dmarcPolicy } = ctx;
	const { route, rcptTo, attachments, headers } = attempt;
	const effects: BounceEffect[] = [];

	// Build attachment metadata with deterministic redisKeys; emit a
	// stage_attachment effect for every attachment whose content was parsed.
	const messageIdForKey = parsed.messageId ?? 'unknown';
	const attachmentMeta = attachments.map((att) => {
		if (att.contentBase64) {
			const redisKey = `mta:inbound-att:${messageIdForKey}:${att.index}`;
			effects.push({
				kind: 'stage_attachment',
				redisKey,
				contentBase64: att.contentBase64,
				ttlSeconds: 3600,
			});
			return {
				filename: att.filename,
				contentType: att.contentType,
				size: att.size,
				redisKey,
			};
		}
		return {
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			redisKey: undefined as string | undefined,
		};
	});

	const referencesString = Array.isArray(parsed.references)
		? parsed.references.join(' ')
		: (parsed.references ?? undefined);

	effects.push({
		kind: 'notify_convex',
		event: {
			event: 'inbound.received',
			messageId: parsed.messageId,
			organizationId: route.organizationId,
			message: `Inbound from ${parsed.from?.text} to ${rcptTo}`,
			inboundPayload: {
				from: parsed.from?.text ?? '',
				to: rcptTo,
				subject: parsed.subject ?? '(no subject)',
				textBody: parsed.text ?? undefined,
				htmlBody: parsed.html !== false ? (parsed.html ?? undefined) : undefined,
				headers: { ...headers },
				date: parsed.date?.toISOString(),
				messageId: parsed.messageId ?? undefined,
				inReplyTo: parsed.inReplyTo?.replace(/[<>]/g, '') ?? undefined,
				references: referencesString,
				// RFC 8601 inbound auth verdicts (SPF/DKIM/DMARC + published policy),
				// computed in `onData` and threaded through the ctx. The AI-inbox
				// path used to DROP these before persisting; now they ride to
				// `inboundMessages` so the reader can show an honest sender badge.
				// Absent verdicts stay absent (renders "unknown", never "pass").
				spfResult,
				dkimResult,
				dmarcResult,
				dmarcPolicy,
				attachments: attachmentMeta,
			},
			timestamp: Date.now(),
		},
	});

	return { effects };
}
