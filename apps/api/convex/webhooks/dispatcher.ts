/**
 * Webhook dispatcher — the shared switch that routes an Inbound delivery
 * event to its downstream domain mutation. See CONTEXT.md "Webhook
 * dispatcher".
 *
 * Typed dispatch table `{ [K in InboundEvent['kind']]: Handler<K> }`
 * — adding a new kind to the union without registering a handler is a
 * compile error. Postbox routing (the `pb-` prefix convention) is handled
 * inline via `isPostboxMessageId` so adapters never need to care.
 *
 * Negative-feedback events (`email.bounced` / `email.complained`) whose
 * `providerMessageId` resolves to no Send row now emit an `unresolved_bounce`
 * signal via `recordUnresolvedBounce` instead of acking silently — see that
 * function for the rationale (M3AAWG measure-unattributable-feedback).
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { extractArmoredCiphertext } from '@owlat/shared/secureMessage';
import { isAllowedSnsHost } from './adapters/ses';
import { isPostboxMessageId } from '../delivery/messageIdRouting';
import type { TransitionOutcome } from '../delivery/sendLifecycle';
import { withTimeout } from '../lib/inputGuards';
import { logError, logWarn } from '../lib/runtimeLog';
import type { InboundEvent, InboundEventKind, InboundEventOf } from './types';

/** Max time to wait for the SNS subscription-confirm GET before giving up. */
const SNS_CONFIRM_FETCH_TIMEOUT_MS = 10_000;

/**
 * Unresolved-bounce observability (M3AAWG "measure unattributable feedback").
 *
 * `transitionByProviderMessageId` returns `{ ok: false, reason:
 * 'send_not_found' }` when a provider message id resolves to no Send row, and
 * the webhook path otherwise acks silently. For a negative-signal event
 * (`email.bounced` / `email.complained`) that silence hides a real failure
 * class: a bounce the MTA attributed (so the worker-side unattributed-bounce
 * counter never fires) but which is lost at the Convex resolve step — e.g. the
 * VERP-token-vs-stored-providerMessageId mismatch (PR-01). Without a signal
 * here those bounces are invisible end-to-end.
 *
 * So: when a negative-signal transition resolves to `send_not_found`, emit a
 * structured `unresolved_bounce` warning carrying the event kind and provider
 * message id. The literal token makes the mismatch observable to log-based
 * metrics/alerts rather than a no-op.
 */
function recordUnresolvedBounce(
	signal: 'email.bounced' | 'email.complained',
	providerMessageId: string,
	at: number,
	outcome: TransitionOutcome | undefined
): void {
	// Only the specific no-row outcome is a signal; any other shape (success,
	// a different failure reason, or an absent return) is a quiet no-op.
	if (!outcome || outcome.ok || outcome.reason !== 'send_not_found') return;
	logWarn(
		`[Webhook Dispatcher] unresolved_bounce: ${signal} for providerMessageId ` +
			`${providerMessageId} resolved to no Send row (at=${at}). The bounce was ` +
			`attributed at the MTA but lost at Convex resolve — measure-unattributable-feedback.`
	);
}

type Handler<K extends InboundEventKind> = (
	ctx: ActionCtx,
	event: InboundEventOf<K>
) => Promise<unknown>;

type DispatchTable = { [K in InboundEventKind]: Handler<K> };

const DISPATCH: DispatchTable = {
	'internal.routing_reentry': async (ctx, e) => {
		return await ctx.runMutation(internal.delivery.routingReentry.consumeSnapshot, {
			token: e.token,
			messageId: e.providerMessageId,
			workAttemptId: e.workAttemptId,
			reason: e.reason,
			envelopeInput: e.envelopeInput,
			retryState: e.retryState,
		});
	},
	'email.sent': async (ctx, e) => {
		if (isPostboxMessageId(e.providerMessageId)) {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId, {
				rawProviderMessageId: e.providerMessageId,
				input: { to: 'sent', at: e.at },
			});
			return;
		}
		await ctx.runMutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: e.providerMessageId,
			transition: {
				to: 'sent',
				at: e.at,
				providerMessageId: e.providerMessageId,
				...(e.providerType ? { providerType: e.providerType } : {}),
			},
		});
	},
	'email.delivered': async (ctx, e) => {
		const outcome = isPostboxMessageId(e.providerMessageId)
			? await ctx.runMutation(
					internal.mail.postboxOutboundLifecycle.observeRemoteAcceptanceByMtaMessageId,
					{
						rawProviderMessageId: e.providerMessageId,
						acceptedAt: e.at,
					}
				)
			: e.providerType === 'mta'
				? await ctx.runMutation(internal.delivery.sendLifecycle.recordMtaRemoteAcceptance, {
						providerMessageId: e.providerMessageId,
						at: e.at,
					})
				: await ctx.runMutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
						providerMessageId: e.providerMessageId,
						transition: { to: 'delivered', at: e.at },
					});

		// A late webhook after organization deletion must not recreate telemetry.
		// Duplicate accepted-delivery webhooks are safe: the receipt writer below
		// is idempotent by provider message id.
		const isProductionTelemetry =
			e.providerType === 'mta'
				? e.deliveryDomain === 'production'
				: e.deliveryDomain !== 'member_test';
		if (
			isProductionTelemetry &&
			outcome.ok &&
			e.destinationProvider === 'gmail' &&
			e.primarySendingDomain
		) {
			await ctx.runMutation(internal.delivery.complianceTelemetry.recordGmailDelivery, {
				providerMessageId: e.providerMessageId,
				primaryDomain: e.primarySendingDomain,
				acceptedAt: e.at,
			});
		}
		if (isProductionTelemetry && outcome.ok && e.destinationProvider) {
			await ctx.runMutation(
				internal.delivery.deliverabilityRouting.recordDestinationProviderDomain,
				{
					providerMessageId: e.providerMessageId,
					destinationProvider: e.destinationProvider,
					observedAt: e.at,
				}
			);
		}
	},
	'email.failed': async (ctx, e) => {
		// Terminal, NON-bounce failure (screening/suppression or an ambiguous
		// post-DATA drop). Transition the
		// send row to `failed` so it leaves "sending" — deliberately NOT `bounced`:
		// `reduceFailed` applies no recipient suppression and no reputation penalty,
		// because the receiver may have accepted the message and the address is very
		// likely valid.
		if (isPostboxMessageId(e.providerMessageId)) {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId, {
				rawProviderMessageId: e.providerMessageId,
				input: {
					to: 'failed',
					at: e.at,
					errorMessage: e.errorMessage,
					errorCode: e.errorCode,
				},
			});
			return;
		}
		await ctx.runMutation(
			e.providerType === 'mta'
				? internal.delivery.sendLifecycle.transitionMtaByProviderMessageId
				: internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: e.providerMessageId,
				transition: {
					to: 'failed',
					at: e.at,
					errorMessage: e.errorMessage,
					errorCode: e.errorCode,
				},
			}
		);
	},
	'email.bounced': async (ctx, e) => {
		if (isPostboxMessageId(e.providerMessageId)) {
			// Postbox does not distinguish hard/soft at the per-recipient level —
			// the Send lifecycle's `bounceType` is a campaign-side concern (drives
			// blocklist insert + reputation). Personal mail discards the
			// classification per ADR-0012.
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transitionByMtaMessageId, {
				rawProviderMessageId: e.providerMessageId,
				input: {
					to: 'bounced',
					at: e.at,
					...(e.bounceMessage ? { bounceMessage: e.bounceMessage } : {}),
				},
			});
			return;
		}
		const outcome = (await ctx.runMutation(
			e.providerType === 'mta'
				? internal.delivery.sendLifecycle.transitionMtaByProviderMessageId
				: internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: e.providerMessageId,
				transition: {
					to: 'bounced',
					at: e.at,
					bounceType: e.bounceType,
					...(e.bounceMessage ? { bounceMessage: e.bounceMessage } : {}),
				},
			}
		)) as TransitionOutcome;
		recordUnresolvedBounce('email.bounced', e.providerMessageId, e.at, outcome);
	},
	'email.complained': async (ctx, e) => {
		// Recipient-only complaint (RFC 5965 §3.2): the FBL redacted the
		// original Message-ID (e.g. Gmail), so there's no send to transition.
		// Suppress the complainer directly by email — a complaint must always
		// reach the blocklist, never evaporate into a metric.
		if (!e.providerMessageId) {
			if (!e.recipient || (e.providerType !== 'ses' && e.deliveryDomain !== 'production')) return;
			await ctx.runMutation(internal.blockedEmails.addFromEvent, {
				email: e.recipient,
				reason: 'complained',
			});
			return;
		}
		if (isPostboxMessageId(e.providerMessageId)) return;
		const outcome = (await ctx.runMutation(
			e.providerType === 'mta'
				? internal.delivery.sendLifecycle.transitionMtaByProviderMessageId
				: internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{
				providerMessageId: e.providerMessageId,
				transition: { to: 'complained', at: e.at },
			}
		)) as TransitionOutcome;
		recordUnresolvedBounce('email.complained', e.providerMessageId, e.at, outcome);
	},
	'email.opened': async (ctx, e) => {
		if (isPostboxMessageId(e.providerMessageId)) return;
		await ctx.runMutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: e.providerMessageId,
			transition: { to: 'opened', at: e.at },
		});
	},
	'email.clicked': async (ctx, e) => {
		if (isPostboxMessageId(e.providerMessageId)) return;
		await ctx.runMutation(internal.delivery.sendLifecycle.transitionByProviderMessageId, {
			providerMessageId: e.providerMessageId,
			transition: { to: 'clicked', at: e.at, url: e.url },
		});
	},
	'inbound.received': async (ctx, e) => {
		const m = e.mail;
		const attachmentMeta = m.attachments.length > 0 ? JSON.stringify(m.attachments) : undefined;

		// Sealed Mail (E4, D3): decrypt-on-ingest for the AI-inbox path. When Sealed
		// Mail is on and the body carries an armored PGP ciphertext, route through the
		// Node decrypt action so the PLAINTEXT reaches `receiveMessage` (and thus the
		// agent pipeline + the unified-timeline mirror). Anything else — plaintext,
		// flag off, or a ciphertext we cannot recover here — takes the unchanged path.
		const armoredCiphertext = m.textBody ? extractArmoredCiphertext(m.textBody) : null;
		if (armoredCiphertext && (await ctx.runQuery(internal.e2ee.keys.isSealedMailEnabled, {}))) {
			await ctx.runAction(internal.e2ee.open.decryptAndReceive, {
				armoredCiphertext,
				recipientAddress: m.to,
				from: m.from,
				to: m.to,
				subject: m.subject,
				textBody: m.textBody,
				htmlBody: m.htmlBody,
				headers: JSON.stringify(m.headers),
				messageId: m.messageId,
				inReplyTo: m.inReplyTo,
				references: m.references,
				attachmentMeta,
				timestamp: m.timestamp,
				spfResult: m.spfResult,
				dkimResult: m.dkimResult,
				dmarcResult: m.dmarcResult,
				dmarcPolicy: m.dmarcPolicy,
			});
			return;
		}

		await ctx.runMutation(internal.inbox.messages.receiveMessage, {
			from: m.from,
			to: m.to,
			subject: m.subject,
			textBody: m.textBody,
			htmlBody: m.htmlBody,
			headers: JSON.stringify(m.headers),
			messageId: m.messageId,
			inReplyTo: m.inReplyTo,
			references: m.references,
			attachmentMeta,
			timestamp: m.timestamp,
			// RFC 8601 inbound auth verdicts. Previously dropped on this AI-inbox
			// path; now persisted so the reader can show an honest sender badge.
			spfResult: m.spfResult,
			dkimResult: m.dkimResult,
			dmarcResult: m.dmarcResult,
			dmarcPolicy: m.dmarcPolicy,
		});
	},
	'channel.received': async (ctx, e) => {
		await ctx.runMutation(internal.webhooks.channels.processInboundChannel, {
			channel: e.channel,
			from: e.from,
			content: JSON.stringify(e.content),
			externalMessageId: e.externalMessageId,
			metadata: e.metadata ? JSON.stringify(e.metadata) : undefined,
		});
	},
	'internal.circuit_breaker_tripped': async (ctx, e) => {
		// eslint-disable-next-line no-console
		console.warn(`[Webhook Dispatcher] Circuit breaker tripped: ${e.message}`);
		try {
			// Per ADR-0011 the legacy `throttled` literal was dropped; the
			// circuit-breaker signal re-targets to `warned` (no operational
			// behavior change — `throttled` never gated sends in the Abuse
			// gate; both `warned` and the old `throttled` are advisory).
			await ctx.runMutation(internal.workspaces.abuseStatus.transition, {
				input: {
					to: 'warned',
					at: Date.now(),
					reason: `MTA circuit breaker: ${e.message}${
						e.bounceRate !== undefined ? ` (bounce rate: ${(e.bounceRate * 100).toFixed(2)}%)` : ''
					}`,
					changedBy: 'mta_circuit_breaker',
				},
			});
		} catch (err) {
			logError('[Webhook Dispatcher] Failed to set abuse status for circuit breaker:', err);
		}
	},
	'internal.sns_subscription_confirm': async (_ctx, e) => {
		// Activate the SES feedback subscription by GET-ing SubscribeURL. The
		// adapter already pinned the host and the whole envelope's signature was
		// verified upstream; re-check the host here as defense-in-depth against a
		// future caller (SSRF: never fetch an un-pinned URL).
		if (!isAllowedSnsHost(e.subscribeUrl)) {
			logError(
				`[Webhook Dispatcher] Refusing SNS subscription confirm for non-SNS host: ${e.subscribeUrl}`
			);
			return;
		}
		try {
			const res = await withTimeout(
				fetch(e.subscribeUrl),
				SNS_CONFIRM_FETCH_TIMEOUT_MS,
				'SNS subscription confirm timed out'
			);
			if (!res.ok) {
				logError(
					`[Webhook Dispatcher] SNS subscription confirm returned ${res.status} for ${e.subscribeUrl}`
				);
			}
		} catch (err) {
			logError('[Webhook Dispatcher] SNS subscription confirm fetch failed:', err);
		}
	},
	'internal.dkim_rotated': async (ctx, e) => {
		const outcome = await ctx.runMutation(internal.domains.lifecycle.recordDkimRotation, {
			domain: e.domain,
			selector: e.selector,
			dnsRecord: e.dnsRecord,
			phase: e.phase,
			userId: 'system:dkim_rotation',
		});
		if (outcome && !outcome.ok) {
			logError(
				`[Webhook Dispatcher] DKIM rotation for ${e.domain} (${e.selector}) not propagated: ${outcome.reason}`
			);
		}
	},
	'internal.campaign_complaint_rate': async (ctx, e) => {
		// A single campaign crossing Gmail's 0.3% spam ceiling is an
		// operator-actionable abuse signal. Mirror the circuit-breaker handler:
		// flip the instance abuse status to `warned` (advisory, never auto-pauses
		// sends) with a campaign-specific reason + audit entry so the alert is
		// persisted and operator-visible instead of being a dead drop.
		// eslint-disable-next-line no-console
		console.warn(`[Webhook Dispatcher] Campaign complaint rate alert: ${e.message}`);
		const outcome = await ctx.runMutation(
			internal.workspaces.abuseStatus.recordCampaignComplaintAlert,
			{
				eventId: e.eventId,
				campaignId: e.campaignId,
				message: e.message,
				complaintRate: e.complaintRate,
				eventTimestamp: e.at,
			}
		);
		// The mutation acknowledges every durably recorded alert, including one
		// whose status change severity rules refused (`applied: 'skipped'`).
		// Only a missing settings row (transient) and a reused event id with
		// different content (integrity violation) reach a non-2xx and let the
		// MTA retry its protected outbox row.
		if (!outcome.ok) {
			throw new Error(`Campaign complaint alert was not persisted: ${outcome.reason}`);
		}
		return outcome;
	},
	'internal.ip_event': async (ctx, e) => {
		const level = e.severity === 'critical' ? 'error' : 'warn';
		console[level](`[Webhook Dispatcher] ${e.subkind}: ${e.message ?? ''}`);
		if (
			e.subkind === 'warming_complete' ||
			e.subkind === 'blocklisted' ||
			e.subkind === 'delisted'
		) {
			try {
				await ctx.scheduler.runAfter(0, internal.delivery.warmingSync.syncWarmingState, {});
			} catch (err) {
				// eslint-disable-next-line no-console
				console.error('[Webhook Dispatcher] Failed to trigger warming sync:', err);
			}
		}
	},
	'internal.postmaster_stats': async (ctx, e) => {
		return ctx.runMutation(internal.delivery.postmaster.ingest, {
			domain: e.domain,
			date: e.date,
			userReportedSpamRatio: e.userReportedSpamRatio,
			fetchedAt: e.fetchedAt,
		});
	},
	'internal.postmaster_authorize_domain': async (ctx, e) => {
		return ctx.runMutation(internal.delivery.postmaster.authorizeDomain, {
			domain: e.domain,
		});
	},
};

export function dispatchInboundEvent(ctx: ActionCtx, event: InboundEvent): Promise<void>;
export function dispatchInboundEvent(
	ctx: ActionCtx,
	event: InboundEvent,
	options: { returnResult: true }
): Promise<unknown>;
export async function dispatchInboundEvent(
	ctx: ActionCtx,
	event: InboundEvent,
	_options?: { returnResult: true }
): Promise<unknown> {
	const handler = DISPATCH[event.kind] as Handler<InboundEventKind>;
	return handler(ctx, event as InboundEventOf<InboundEventKind>);
}
