'use node';

/**
 * Post-delivery hooks for inbound messages: forwarding + vacation
 * auto-reply. Runs as a Node action (scheduled by
 * `mailDelivery.deliverToMailbox`) so we can talk to the MTA over HTTP
 * and parse RFC 3834 anti-loop headers without dragging Node APIs into
 * the v8 isolate.
 */

import { v } from 'convex/values';
import sanitizeHtml from 'sanitize-html';
import { POSTBOX_SANITIZE_CONFIG } from '@owlat/shared/postboxSanitize';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import { isAutomatedMail } from '../lib/inboundClassification';
import { getMtaConfig } from './mtaClient';

/**
 * Sanitize inbound HTML before re-emitting it through our outbound MTA.
 * The forwarded message ships out under the user's domain and may be
 * DKIM-signed by the MTA, which would launder the original sender's
 * phishing/XSS payload through the user's reputation. We re-run the
 * Postbox allowlist over the body to strip script tags, event handlers,
 * meta-refresh, base href, etc.
 */
function sanitizeForwardedHtml(html: string): string {
	return sanitizeHtml(html, POSTBOX_SANITIZE_CONFIG);
}

/**
 * Re-emit a delivered message to a forwarding target via the outbound MTA.
 *
 * Exported for unit testing: the forward re-originates under the mailbox's own
 * domain (so the outbound DKIM/SPF check passes) and therefore must carry the
 * original sender in Reply-To, or replies would land on the forwarding mailbox
 * instead of the person who actually wrote the message.
 */
export async function forwardToTarget(
	mta: { baseUrl: string; apiKey: string },
	args: {
		mailboxId: string;
		mailboxAddress: string;
		fromAddress: string;
		subject: string;
		bodyText?: string;
		bodyHtml?: string;
	},
	target: string,
): Promise<void> {
	const selfLower = args.mailboxAddress.toLowerCase();
	await fetch(`${mta.baseUrl}/send`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${mta.apiKey}`,
		},
		body: JSON.stringify({
			messageId: `pb-fwd-${args.mailboxId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			from: args.mailboxAddress,
			// Re-originating under the mailbox's domain (so DKIM/SPF pass on the
			// outbound hop) drops the original sender from the From line. Point
			// Reply-To at the original sender so a reply reaches them, not the
			// forwarder. A non-ARC remail: legitimate, but it must preserve the
			// original sender's reply context (RFC 7960).
			replyTo: args.fromAddress,
			to: target,
			subject: `Fwd: ${args.subject}`,
			html: args.bodyHtml
				? sanitizeForwardedHtml(args.bodyHtml)
				: `<pre>${(args.bodyText ?? '').replace(/</g, '&lt;')}</pre>`,
			text: args.bodyText,
			headers: {
				'X-Owlat-Forwarded': args.mailboxAddress,
				'X-Owlat-Forwarded-From': args.fromAddress,
				'Auto-Submitted': 'auto-forwarded',
			},
			ipPool: 'transactional',
			organizationId: 'postbox',
			dkimDomain: selfLower.split('@')[1] ?? 'localhost',
		}),
	});
}

/**
 * Pure RFC 3834 §2 / RFC 5321 §4.5.5 auto-reply gate.
 *
 * Decides whether a vacation responder may fire for an inbound message,
 * BEFORE the per-sender dedup / window checks (those need a DB read). Keyed
 * off the SMTP *envelope* sender (return-path), never the `From:` header —
 * the header is trivially spoofable (a DSN sets `From: MAILER-DAEMON`), so
 * keying the loop guard off it lets bounces/DSNs draw an auto-reply, which is
 * backscatter to a forged address.
 *
 * Returns false (suppress the auto-reply) when:
 *   - the message is automated (Auto-Submitted / List-Id / Precedence / our
 *     own forward header — via isAutomatedMail),
 *   - the sender is the mailbox itself (self-send loop),
 *   - the SMTP return-path is the null sender (`''` — a bounce/DSN), or
 *   - there is no `From:` address to reply to.
 *
 * `returnPath === undefined` means a legacy MTA build didn't thread the
 * envelope; we do NOT suppress on that alone (the empty string is the
 * explicit null-sender signal).
 *
 * Exported for unit testing: the suppression rule is the security-critical
 * part of the hook and must be verifiable without standing up Convex + an MTA.
 */
export function shouldAutoReply(args: {
	fromAddress: string;
	mailboxAddress: string;
	returnPath?: string;
	headers: Record<string, string>;
}): boolean {
	if (isAutomatedMail(args.headers)) return false;
	const fromLower = args.fromAddress.toLowerCase();
	if (fromLower === '') return false;
	if (fromLower === args.mailboxAddress.toLowerCase()) return false;
	// `''` = null SMTP return-path (MAIL FROM:<>), i.e. a bounce/DSN.
	if (args.returnPath !== undefined && args.returnPath.trim() === '') return false;
	return true;
}

/**
 * Pick the recipient for a vacation auto-reply.
 *
 * RFC 3834 §4: an automatic responder SHOULD direct its response to the
 * envelope return-path (RFC 5321 MAIL FROM), not the `From:` header, so the
 * reply reaches the agent that actually injected the message rather than a
 * forged or secondary `From:`. We fall back to the `From:` header only when the
 * envelope return-path wasn't threaded (legacy MTA build → `undefined`).
 *
 * The null sender (`''`) never reaches here — `shouldAutoReply` suppresses the
 * whole auto-reply for it (a bounce/DSN). Exported for unit testing.
 */
export function autoReplyRecipient(args: {
	fromAddress: string;
	returnPath?: string;
}): string {
	const rp = args.returnPath?.trim();
	if (rp) return rp.toLowerCase();
	return args.fromAddress.toLowerCase();
}

/**
 * Build the RFC 5322 threading headers for a vacation auto-reply so it reads as
 * a reply to the triggering message rather than a thread-orphaning new message
 * (RFC 3834 §3.1.5 In-Reply-To, §3.1.6 References).
 *
 * - `In-Reply-To` is the triggering message's Message-Id.
 * - `References` is the triggering message's own References chain (if any)
 *   followed by its Message-Id, space-separated, per RFC 5322 §3.6.4.
 *
 * Returns an empty object when there is no triggering Message-Id (a malformed
 * inbound message), so we never emit empty header values. Exported for testing.
 */
export function autoReplyThreadingHeaders(args: {
	triggeringMessageId?: string;
	triggeringReferences?: string;
}): { 'In-Reply-To'?: string; References?: string } {
	const msgId = args.triggeringMessageId?.trim();
	if (!msgId) return {};
	const prior = args.triggeringReferences?.trim();
	const references = prior ? `${prior} ${msgId}` : msgId;
	return { 'In-Reply-To': msgId, References: references };
}

export const runPostDelivery = internalAction({
	args: {
		mailboxId: v.id('mailboxes'),
		mailboxAddress: v.string(),
		messageId: v.id('mailMessages'),
		fromAddress: v.string(),
		// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for the null sender of
		// a bounce/DSN, undefined on legacy MTA builds that don't thread it.
		// Vacation auto-replies are suppressed when this is the empty string so
		// we never backscatter a reply to a bounce (RFC 3834 §2). The `From:`
		// header (fromAddress) is spoofable and cannot be the loop guard.
		//
		// It is ALSO the address a vacation auto-reply is sent to: RFC 3834 §4
		// requires a responder to reply to the envelope return-path, not the
		// `From:` header, so a reply reaches the actual sending agent and not a
		// forged/secondary `From:`. Falls back to the `From:` header only when
		// the envelope wasn't threaded (legacy MTA build).
		returnPath: v.optional(v.string()),
		// RFC Message-Id of the inbound message that triggered the auto-reply
		// (RFC 5322 message-id, angle-bracketed, e.g. `<abc@host>`). Threaded
		// into the vacation reply's `In-Reply-To`/`References` so the responder
		// is a proper reply in the originating thread (RFC 3834 §3.1.5/§3.1.6),
		// not an orphan message. Optional: a malformed inbound message may have
		// no Message-Id.
		triggeringMessageId: v.optional(v.string()),
		// References chain of the inbound message (RFC 5322 references), if any.
		// Prepended ahead of the triggering Message-Id when building the reply's
		// References header so the full thread history is preserved.
		triggeringReferences: v.optional(v.string()),
		subject: v.string(),
		bodyText: v.optional(v.string()),
		bodyHtml: v.optional(v.string()),
		// Headers serialized as a JSON object (string → string). Optional
		// keys (auto-submitted / list-id / precedence / x-owlat-forwarded)
		// are the only ones we read.
		headers: v.record(v.string(), v.string()),
		// Filter-level "Forward to…" action targets (mail/filters.ts), forwarded
		// alongside the account-level mailForwarding rules.
		filterForwardTo: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const headers = (args.headers ?? {}) as Record<string, string>;
		const automated = isAutomatedMail(headers);
		const fromLower = args.fromAddress.toLowerCase();
		const selfLower = args.mailboxAddress.toLowerCase();

		const mta = getMtaConfig();

		// ── Forwarding (account-level rules + filter "Forward to…" actions) ──
		if (!automated && mta) {
			const forwarding = await ctx.runQuery(internal.mail.forwarding.internalListForMailbox, {
				mailboxId: args.mailboxId,
			});
			const targets = [
				...forwarding.filter((r) => r.isEnabled).map((r) => r.forwardTo),
				...(args.filterForwardTo ?? []),
			];
			// De-dup and skip forwarding to the mailbox itself (anti-loop).
			const seen = new Set<string>();
			for (const target of targets) {
				const lower = target.toLowerCase();
				if (lower === selfLower || seen.has(lower)) continue;
				seen.add(lower);
				try {
					await forwardToTarget(mta, args, target);
					logInfo(`[Forwarding] ${args.mailboxAddress} → ${target}`);
				} catch (err) {
					logError('[Forwarding] failed:', err);
				}
			}
		}

		// ── Vacation auto-reply ──────────────────────────────────────
		// Single pure gate: automated / self-send / null-return-path (bounce) /
		// no-sender. See shouldAutoReply for the RFC 3834 §2 rationale. Keyed off
		// the SMTP envelope return-path, NOT the spoofable `From:` header, so a
		// DSN with `From: MAILER-DAEMON` and no Auto-Submitted header is skipped.
		if (
			!shouldAutoReply({
				fromAddress: args.fromAddress,
				mailboxAddress: args.mailboxAddress,
				returnPath: args.returnPath,
				headers,
			})
		) {
			return;
		}

		const responder = await ctx.runQuery(internal.mail.vacation.internalLoad, {
			mailboxId: args.mailboxId,
		});
		if (!responder || !responder.isEnabled) return;

		const now = Date.now();
		if (responder.startAt && now < responder.startAt) return;
		if (responder.endAt && now > responder.endAt) return;

		// Dedup window
		const lastRepliedAt = await ctx.runQuery(internal.mail.vacation.internalLastReplied, {
			mailboxId: args.mailboxId,
			senderEmail: fromLower,
		});
		const intervalMs = responder.replyIntervalDays * 24 * 60 * 60 * 1000;
		if (lastRepliedAt && now - lastRepliedAt < intervalMs) return;

		if (!mta) {
			logInfo('[Vacation] MTA not configured; skipping auto-reply');
			return;
		}

		// RFC 3834 §4: reply to the envelope return-path, not the spoofable
		// `From:` header (falls back to `From:` on a legacy build that didn't
		// thread the envelope). The null sender never reaches here — it is
		// suppressed by shouldAutoReply above.
		const replyTo = autoReplyRecipient({
			fromAddress: args.fromAddress,
			returnPath: args.returnPath,
		});
		// RFC 3834 §3.1.5/§3.1.6: thread the reply onto the triggering message
		// (In-Reply-To + References) so it isn't a thread-orphaning new message.
		const threadingHeaders = autoReplyThreadingHeaders({
			triggeringMessageId: args.triggeringMessageId,
			triggeringReferences: args.triggeringReferences,
		});

		try {
			await fetch(`${mta.baseUrl}/send`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${mta.apiKey}`,
				},
				body: JSON.stringify({
					messageId: `pb-vac-${args.mailboxId}-${now}-${Math.random().toString(36).slice(2, 8)}`,
					from: args.mailboxAddress,
					to: replyTo,
					subject: responder.subject,
					html: responder.bodyHtml ?? `<p>${responder.bodyText.replace(/\n/g, '<br>')}</p>`,
					text: responder.bodyText,
					headers: {
						// RFC 3834 §5: marks this as an automatic reply so other
						// responders won't reply back to it (loop prevention). This,
						// not the non-standard `Precedence: auto_reply`, is the
						// recognized signal — `Precedence` is dropped.
						'Auto-Submitted': 'auto-replied',
						'X-Auto-Response-Suppress': 'All',
						// RFC 3834 §3.1.5 / §3.1.6: thread onto the triggering message.
						...threadingHeaders,
					},
					ipPool: 'transactional',
					organizationId: 'postbox',
					dkimDomain: selfLower.split('@')[1] ?? 'localhost',
				}),
			});
			await ctx.runMutation(internal.mail.vacation.internalRecordReply, {
				mailboxId: args.mailboxId,
				senderEmail: fromLower,
			});
			logInfo(`[Vacation] auto-replied ${args.mailboxAddress} → ${fromLower}`);
		} catch (err) {
			logError('[Vacation] auto-reply failed:', err);
		}
	},
});
