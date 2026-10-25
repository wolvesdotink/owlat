'use node';

/**
 * Outbound personal mail — the DISPATCH half.
 *
 * Two transports for an already-built, already-stored message, branched on the
 * sending mailbox's kind by `../outbound.ts`:
 *
 *   - {@link dispatchViaMta} — hosted mailboxes, one POST per recipient to the
 *     MTA `/send/postbox` intake. Delivery outcomes arrive later by webhook;
 *     only synchronous refusals are recorded here.
 *   - {@link dispatchViaExternalWorker} — external mailboxes, a SINGLE POST to
 *     the mail-sync worker, which relays through the user's own SMTP.
 *
 * Both drive `mail.postboxOutboundLifecycle.transition` for per-recipient
 * outcomes; neither builds or seals anything (that is `./build.ts`).
 */

import { v } from 'convex/values';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { isRecord } from '@owlat/shared';
import type { ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { logError, logEvent } from '../../lib/runtimeLog';
import { correlationHeader, mintCorrelationId } from '@owlat/shared/correlation';
import { redactEmailAddress } from '@owlat/shared/logRedaction';
import { sealedBlobUrl } from '../../lib/sealedBlob';
import { getMailSyncConfig } from '../mtaClient';
import { FETCH_TIMEOUTS, fetchWithTimeout } from '../../lib/fetchWithTimeout';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency';
import type { DraftRow } from '../rfc822';
import type { MtaSendRequest } from '@owlat/mta-protocol/send';
import type { SealedMime } from '../../e2ee/seal';

/**
 * How many MTA intake POSTs one send keeps in flight. Each carries its own copy
 * of the message body (attachments included, up to ~14 MB of base64), so an
 * unbounded fan-out over a long recipient list could exhaust the action's
 * memory; six covers the usual To/Cc/Bcc list in a single round.
 */
const POSTBOX_SEND_CONCURRENCY = 6;

/**
 * One recipient's verdict in the mail-sync worker's `/send` answer. `status` is
 * read as a string so a verdict this build does not know counts as sent, as a
 * missing entry does; only `bounced` is a rejection. `error` is read loosely so
 * a bounce whose message is not text is still a bounce.
 */
const decodeRecipientVerdict = validatorDecoder(
	v.object({ address: v.string(), status: v.string(), error: v.optional(v.any()) })
);

interface RecipientVerdict {
	address: string;
	status: string;
	error?: string;
}

/**
 * The readable per-recipient verdicts of a `/send` answer, plus a path-only
 * description of every part that could not be read. Each entry is checked on
 * its own: a 2xx answer does not by itself mean SMTP accepted the message (the
 * worker answers an SMTPUTF8 refusal with a 2xx that bounces every recipient),
 * so one unreadable entry must not discard the bounces listed next to it.
 */
function readExternalSendVerdicts(body: unknown): {
	verdicts: RecipientVerdict[];
	unreadable: string[];
} {
	if (!isRecord(body)) return { verdicts: [], unreadable: ['$: expected object'] };
	const recipients = body['recipients'];
	if (recipients === undefined) return { verdicts: [], unreadable: [] };
	if (!Array.isArray(recipients)) {
		return { verdicts: [], unreadable: ['$.recipients: expected array'] };
	}
	const entries: unknown[] = recipients;
	const verdicts: RecipientVerdict[] = [];
	const unreadable: string[] = [];
	for (const [i, entry] of entries.entries()) {
		const decoded = decodeRecipientVerdict(entry);
		if (!decoded.ok) {
			unreadable.push(decoded.issue.replace(/^\$/, `$.recipients[${i}]`));
			continue;
		}
		const { address, status, error } = decoded.value;
		verdicts.push({ address, status, ...(typeof error === 'string' ? { error } : {}) });
	}
	return { verdicts, unreadable };
}

/**
 * Dispatch a Sent-folder message through the user's external SMTP via the
 * mail-sync worker. Unlike the per-recipient MTA path, this is a SINGLE POST —
 * the external provider fans out — and SMTP is synchronous, so we map the
 * worker's per-recipient result straight onto the postbox outbound lifecycle
 * (no webhook). The worker fetches the raw .eml from `rawEmlUrl` and APPENDs the
 * sent copy to the remote Sent folder.
 */
export async function dispatchViaExternalWorker(
	ctx: ActionCtx,
	params: {
		externalAccountId: Id<'externalMailAccounts'>;
		mailMessageId: Id<'mailMessages'>;
		fromAddress: string;
		recipients: string[];
		rawStorageId: Id<'_storage'>;
		rfc822MessageId: string;
	}
): Promise<void> {
	const transitionAll = async (
		input:
			| { to: 'sent'; at: number }
			| { to: 'bounced'; at: number; bounceMessage?: string }
			| { to: 'failed'; at: number; errorMessage: string; errorCode?: string }
	) => {
		for (let i = 0; i < params.recipients.length; i++) {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input,
			});
		}
	};

	const mailSync = getMailSyncConfig();
	if (!mailSync) {
		// Mis-provisioned external-mail install: the mail.external feature is on but
		// the worker URL/key never reached the Convex runtime. Surface a real
		// delivery failure on every recipient instead of silently leaving the
		// message stuck in `queued` forever (the user sees nothing otherwise).
		logError(
			'[Outbound] MAIL_SYNC_API_URL/MAIL_SYNC_API_KEY not set — external message could not be dispatched. Enable the mail.external profile so setup pushes MAIL_SYNC_API_URL + MAIL_SYNC_API_KEY into the Convex runtime.'
		);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage:
				'External mail worker is not configured (MAIL_SYNC_API_URL / MAIL_SYNC_API_KEY missing).',
			errorCode: 'EXTERNAL_NOT_CONFIGURED',
		});
		return;
	}
	// E8b: the stored `.eml` is sealed at rest, so hand the worker a
	// decrypt-serving proxy URL — it fetches back the PLAINTEXT bytes to APPEND
	// the sent copy remotely, exactly as it did with the bare storage URL.
	const rawEmlUrl = await sealedBlobUrl(ctx.storage, params.rawStorageId, 'message/rfc822');
	if (!rawEmlUrl) {
		logError(`[Outbound] Missing raw .eml for external send of ${params.mailMessageId}`);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage: 'Internal error: raw message body was not available for dispatch.',
			errorCode: 'EXTERNAL_RAW_EML_MISSING',
		});
		return;
	}

	let body: unknown;
	try {
		const res = await fetchWithTimeout(
			`${mailSync.baseUrl}/send`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mailSync.apiKey}` },
				body: JSON.stringify({
					externalAccountId: params.externalAccountId,
					messageId: params.rfc822MessageId,
					from: params.fromAddress,
					recipients: params.recipients,
					rawEmlUrl,
				}),
			},
			FETCH_TIMEOUTS.externalSend
		);
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			logError(`[Outbound] mail-sync /send failed: ${res.status} ${body}`);
			await transitionAll({
				to: 'failed',
				at: Date.now(),
				errorMessage: `mail-sync /send ${res.status}: ${body.slice(0, 200)}`,
				errorCode: 'EXTERNAL_SMTP_HTTP',
			});
			return;
		}
		body = await res.json();
	} catch (err) {
		logError('[Outbound] mail-sync /send error:', err);
		await transitionAll({
			to: 'failed',
			at: Date.now(),
			errorMessage: err instanceof Error ? err.message : String(err),
			errorCode: 'EXTERNAL_SMTP_NETWORK',
		});
		return;
	}

	// Only the parts of the answer that cannot be read fall back to sent, as a
	// missing entry does: they name no recipient this code could bounce. Every
	// readable entry keeps its verdict; the log says what was skipped.
	const { verdicts: perRecipient, unreadable } = readExternalSendVerdicts(body);
	if (unreadable.length > 0) {
		logError(`[Outbound] mail-sync /send answered unreadable verdicts (${unreadable.join('; ')})`);
	}
	for (let i = 0; i < params.recipients.length; i++) {
		const addr = params.recipients[i]!;
		const r = perRecipient.find((x) => x.address.toLowerCase() === addr.toLowerCase());
		// A recipient flagged 'bounced' was refused (a per-RCPT rejection, or
		// the worker's SMTPUTF8 refusal of the whole envelope). A recipient with
		// no readable entry defaults to sent: the worker reported no refusal.
		if (r && r.status === 'bounced') {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input: {
					to: 'bounced',
					at: Date.now(),
					bounceMessage: r.error ?? 'Rejected by SMTP server',
				},
			});
		} else {
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId: params.mailMessageId,
				recipientIdx: i,
				input: { to: 'sent', at: Date.now() },
			});
		}
	}
}

/**
 * POST to MTA /send for each recipient. We prefix the MTA messageId with
 * "pb-<mailMessagesId>-" so the bounce/sent webhook can look the row back up.
 *
 * When sealing applied, the complete PGP/MIME bytes pass through the MTA
 * unchanged; the placeholder Subject and ciphertext body are already inside
 * that envelope. When not sealed, the classic structured fields ride exactly
 * as before. (The external worker fetches the same stored `.eml` directly.)
 */
export async function dispatchViaMta(
	ctx: ActionCtx,
	params: {
		draft: DraftRow;
		sealed: SealedMime | null;
		mailMessageId: Id<'mailMessages'>;
		recipients: string[];
		rfc822MessageId: string;
		inReplyToHeaderValue?: string;
		referencesHeaderValue?: string;
		allowedFromAddresses: string[];
		mta: { baseUrl: string; apiKey: string } | null;
	}
): Promise<void> {
	const { draft, sealed, mailMessageId, mta } = params;
	const dkimDomain = draft.fromAddress.split('@')[1] ?? 'localhost';

	const wireContent: Pick<
		MtaSendRequest,
		'subject' | 'html' | 'text' | 'amp' | 'sealedMimeBase64'
	> = sealed
		? {
				subject: sealed.outerSubject,
				html: ' ',
				sealedMimeBase64: Buffer.from(sealed.mime, 'utf-8').toString('base64'),
			}
		: {
				subject: draft.subject || '(no subject)',
				html: draft.bodyHtml || ' ',
				text: draft.bodyText,
				...(draft.bodyAmp ? { amp: draft.bodyAmp } : {}),
			};

	if (!mta) {
		logError(
			'[Outbound] MTA_API_URL/MTA_API_KEY not set — message saved to Sent but not dispatched'
		);
		return;
	}

	// One correlation id for the whole message, so every recipient's MTA job and
	// webhook joins this send's log lines.
	const correlationId = mintCorrelationId('pbx');

	// Every recipient is POSTed concurrently (up to POSTBOX_SEND_CONCURRENCY at
	// once) instead of one after another: each POST is an independent intake
	// with its own `pb-<id>-<idx>` job id, and each keeps its own outcome — a
	// refusal or a network error still lands on that recipient's index alone.
	await mapWithConcurrency(params.recipients, POSTBOX_SEND_CONCURRENCY, async (to, i) => {
		// Prefix lets the `pb-` branch of webhooks/dispatcher.ts parse the
		// Convex mailMessages id out of the `payload.messageId` that
		// webhooks/adapters/mta.ts reports on sent/bounced events. Matches the
		// recipients[idx].mtaJobId written by the lifecycle's
		// insert_mail_message effect.
		const mtaMessageId = `pb-${mailMessageId}-${i}`;
		try {
			const res = await fetchWithTimeout(
				`${mta.baseUrl}/send/postbox`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mta.apiKey}`,
						...correlationHeader(correlationId, 'pbx'),
					},
					// The postbox intake wire, typed against its one declaration.
					// `sealedMimeBase64`, `amp` and `allowedFromAddresses` exist on
					// `MtaSendRequest` for THIS producer and the two in
					// `deliveryHooks.ts` only, so without the annotation they had no
					// compile-time producer at all: renaming one on the MTA side would
					// leave this literal emitting the old key, and the MTA silently
					// dropping the ciphertext / the AMP part / the From allow-list.
					body: JSON.stringify({
						messageId: mtaMessageId,
						from: draft.fromAddress,
						to,
						...wireContent,
						headers: {
							'Message-ID': params.rfc822MessageId,
							...(params.inReplyToHeaderValue
								? { 'In-Reply-To': params.inReplyToHeaderValue }
								: {}),
							...(params.referencesHeaderValue ? { References: params.referencesHeaderValue } : {}),
						},
						// Same IP pool as system/API mail, but not the same queue: the
						// MTA's /send/postbox route puts every job on the `postbox`
						// lane (its own per-domain group), so a transactional burst to
						// a domain does not hold a person's reply back. The lane comes
						// from the route, never from this body.
						ipPool: 'transactional',
						organizationId: 'postbox',
						dkimDomain,
						allowedFromAddresses: params.allowedFromAddresses,
					} satisfies MtaSendRequest),
				},
				FETCH_TIMEOUTS.mtaIntake
			);
			if (!res.ok) {
				const body = await res.text().catch(() => '');
				logEvent(
					'postbox.mta_intake.refused',
					{
						messageId: mtaMessageId,
						correlationId,
						outcome: 'refused',
						detail: { recipient: redactEmailAddress(to), status: res.status, error: body },
					},
					'error'
				);
				// Per-recipient synchronous bounce — record it now rather
				// than waiting forever in `queued`.
				await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
					mailMessageId,
					recipientIdx: i,
					input: {
						to: 'bounced',
						at: Date.now(),
						bounceMessage: `MTA POST ${res.status}: ${body.slice(0, 200)}`,
					},
				});
			}
		} catch (err) {
			logEvent(
				'postbox.mta_intake.failed',
				{
					messageId: mtaMessageId,
					correlationId,
					outcome: 'failed',
					detail: {
						recipient: redactEmailAddress(to),
						error: err instanceof Error ? err.message : String(err),
					},
				},
				'error'
			);
			// Per-recipient pre-MTA error (network failure, DNS, etc.).
			// Recipient resolves to `failed` instead of staying `queued`.
			await ctx.runMutation(internal.mail.postboxOutboundLifecycle.transition, {
				mailMessageId,
				recipientIdx: i,
				input: {
					to: 'failed',
					at: Date.now(),
					errorMessage: err instanceof Error ? err.message : String(err),
					errorCode: 'MTA_POST_NETWORK',
				},
			});
		}
	});
}
