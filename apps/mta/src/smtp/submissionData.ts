/**
 * The submission DATA hook: per-recipient job fan-out off the authenticated
 * SMTP envelope, the From forgery 553 5.7.1 guard for Postbox and per-org
 * credential sessions, and AMP `text/x-amp-html` recovery.
 */

import type { SmtpHandlerResult } from '@owlat/smtp-listener';
import {
	parseMessage,
	parseMimeTree,
	walkLeaves,
	transferDecode,
	type AddressObject,
} from '@owlat/mail-message';
import { emailDomain } from '@owlat/shared/spfAlignment';
import type { EmailJob } from '../types.js';
import { buildGroupKey, extractDomain } from '../queue/groups.js';
import { mapToPriority, priorityToOrderMs } from '../intelligence/engagementPriority.js';
import { logger } from '../monitoring/logger.js';
import { enqueueReconciledIntake } from '../queue/intakeEnqueue.js';
import {
	bindSubmissionClientRequest,
	normalizeEnvelopeAddress,
	resolveSubmissionIdentity,
	submissionRecipientJobId,
} from './submissionIdentity.js';
import type { SubmissionDeps, SubmissionSession } from './submissionSession.js';

function submissionRecipients(session: SubmissionSession): string[] {
	const seen = new Set<string>();
	const recipients: string[] = [];
	for (const recipient of session.rcptTo) {
		const normalized = normalizeEnvelopeAddress(recipient.address);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		recipients.push(normalized);
	}
	return recipients;
}

/** The first From address, lowercased (identity for the forgery guard + DKIM domain). */
function firstFrom(field: AddressObject | AddressObject[] | undefined): string {
	if (!field) return '';
	const obj = Array.isArray(field) ? field[0] : field;
	return obj?.value[0]?.address?.toLowerCase() ?? '';
}

/**
 * Recover the AMP alternative (`text/x-amp-html`) from a raw (binary-string)
 * message, if present. `parseMessage` neither folds a `text/x-amp-html` part
 * into `html`/`text` nor (absent a filename/attachment disposition) surfaces it
 * in `attachments`, so the AMP alternative is recovered by walking the MIME tree
 * directly — preserving the behavior the old `mailparser`-attachment path
 * provided (RFC 2046 §5.1.4).
 *
 * The first `text/x-amp-html` leaf in document order wins, decoded with the
 * package's single `transferDecode` (7bit / QP / base64 — one decoder, no second
 * copy). NOTE (sanctioned divergence, PR body): `MimeNode.rawBody` is CRLF→LF
 * normalized for nested non-`message/*` leaves, so a multi-line
 * AMP document's `job.amp` carries LF line endings rather than the wire's CRLF.
 * This is immaterial: the sender re-encodes the part when re-emitting it, applying
 * canonical CRLF + transfer-encoding on the way out.
 */
function extractAmpHtml(binary: string): string | undefined {
	let amp: string | undefined;
	walkLeaves(parseMimeTree(binary), (leaf) => {
		if (amp !== undefined) return; // first-in-document-order wins
		if (leaf.contentType.value !== 'text/x-amp-html') return;
		const bytes = transferDecode(leaf.rawBody, leaf.headers.last('content-transfer-encoding'));
		amp = Buffer.from(bytes).toString('utf-8');
	});
	return amp;
}

/**
 * DATA handler: parse the body, extract recipients, enforce the From-forgery
 * guard for Postbox sessions, and fan out one queue job per recipient. Exported
 * for tests. Returns a rejection {@link SmtpHandlerResult} to refuse, or nothing
 * to accept with the listener's default 250.
 */
export function buildOnData(deps: Pick<SubmissionDeps, 'queue' | 'redis'>) {
	const { queue, redis } = deps;
	return async function onData(
		message: Buffer,
		session: SubmissionSession
	): Promise<SmtpHandlerResult> {
		try {
			const authData = session.state.auth;
			if (!authData) {
				return { code: 530, enhanced: '5.7.0', text: 'Authentication required' };
			}

			// The listener hands us the fully-buffered, byte-budget-bounded (I4),
			// dot-decoded message. `parseMessage` reads it as a binary string.
			const binary = message.toString('latin1');
			const parsed = parseMessage(binary);

			const recipients = submissionRecipients(session);

			if (recipients.length === 0) {
				return { code: 554, enhanced: '5.5.0', text: 'No valid recipients' };
			}

			const fromAddress = firstFrom(parsed.from);
			const fromDomain = emailDomain(fromAddress);
			const envelope = session.mailFrom;
			if (!envelope?.address) {
				return { code: 503, enhanced: '5.5.1', text: 'MAIL FROM required' };
			}
			const identity = resolveSubmissionIdentity(authData, envelope, parsed.headers, message);
			if (!identity.ok) {
				return { code: 554, enhanced: '5.5.4', text: identity.message };
			}

			// RFC 2046 §5.1.4: preserve the AMP alternative so the sender re-emits the
			// `text/x-amp-html` part (see {@link extractAmpHtml}).
			const amp = extractAmpHtml(binary);

			// Postbox sessions MUST send From: their bound mailbox. Anyone who
			// exfiltrates an app password should not be able to forge identities.
			if (authData.postbox && fromAddress !== authData.postbox.mailboxAddress) {
				logger.warn(
					{ expected: authData.postbox.mailboxAddress, got: fromAddress },
					'SMTP submission rejected — From-address mismatch'
				);
				return {
					code: 553,
					enhanced: '5.7.1',
					text: 'From address must match authenticated mailbox',
				};
			}

			// Per-org credential sessions (not Postbox, not the master key) MUST send
			// From a domain in their organization's verified-sending-domain set (H2).
			// Otherwise a per-org credential could send From any domain and — before
			// the org-scoped DKIM guard — have it signed with another tenant's key.
			// The master session (organizationId '__master__') carries no allowedDomains
			// and keeps broad send; legacy credentials with none recorded stay unscoped
			// here (the DKIM signer is the fail-closed backstop). A present-but-empty
			// set authorizes no domain (fail-closed).
			if (!authData.postbox && authData.allowedDomains) {
				const allowed = new Set(authData.allowedDomains.map((domain) => domain.toLowerCase()));
				if (!allowed.has(fromDomain)) {
					logger.warn(
						{ organizationId: authData.organizationId, fromDomain },
						'SMTP submission rejected — From domain not in organization verified set'
					);
					return {
						code: 553,
						enhanced: '5.7.1',
						text: 'From domain is not authorized for this organization',
					};
				}
			}

			const clientRequestBinding = await bindSubmissionClientRequest(redis, identity, recipients);
			if (clientRequestBinding === 'conflict' || clientRequestBinding === 'recipient-expansion') {
				return {
					code: 554,
					enhanced: '5.5.4',
					text:
						clientRequestBinding === 'conflict'
							? 'Idempotency key is already bound to different message content or sender'
							: 'Idempotency key cannot add recipients after first use',
				};
			}

			// Fan out: one job per recipient.
			let queued = 0;
			for (const to of recipients) {
				// Postbox-prefixed messageId so the bounce/sent webhook can look the
				// row back up — same convention as the webmail dispatch path.
				const prefix = authData.postbox ? `pb-smtp-${authData.postbox.mailboxId}` : 'smtp';
				const messageId = submissionRecipientJobId(prefix, identity.fingerprint, to);
				const job: EmailJob & { intakeReceiptId: string } = {
					messageId,
					intakeReceiptId: messageId,
					to,
					from: fromAddress,
					subject: parsed.subject ?? '(no subject)',
					html: parsed.html || `<pre>${parsed.text ?? ''}</pre>`,
					text: parsed.text,
					...(amp ? { amp } : {}),
					ipPool: 'transactional',
					...(authData.postbox ? { queueLane: 'postbox' as const } : {}),
					organizationId: authData.organizationId,
					dkimDomain: fromDomain,
					firstEnqueuedAt: Date.now(),
				};

				const domain = extractDomain(to);
				const groupId = buildGroupKey(job.ipPool, domain, job.queueLane);
				const priority = mapToPriority(undefined);

				await enqueueReconciledIntake(queue, redis, {
					groupId,
					data: job,
					orderMs: priorityToOrderMs(priority),
				});
				queued++;
			}

			logger.info(
				{
					from: fromAddress,
					recipients: recipients.length,
					queued,
					submissionIdentityMode: identity.mode,
				},
				'SMTP submission accepted'
			);
			return;
		} catch (err) {
			logger.error({ err }, 'SMTP submission processing error');
			return { code: 451, enhanced: '4.3.0', text: 'Processing failed' };
		}
	};
}
