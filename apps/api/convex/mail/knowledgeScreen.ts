/**
 * Screen a Postbox message before it is extracted into the knowledge graph.
 *
 * Mail from a connected (IMAP-synced) mailbox carries no spam verdict: the
 * external delivery path skips scanning because the remote provider already
 * filtered spam. Phishing that the provider let into the inbox would otherwise
 * be extracted like any other mail, and the knowledge graph surfaces to users,
 * the AI assistant and drafted replies. So before either road into the graph
 * (live mail, `mail/liveKnowledge.ts`; the import sweep,
 * `mail/migrationIndexing.ts`) resolves a sender contact or spends an LLM call,
 * it loads the message through `loadExtractableMail`, which refuses anything
 * that looks untrustworthy.
 *
 * Deterministic only (no extra LLM call), and it never changes delivery: a
 * message it refuses stays exactly where it was filed.
 */

import { scanContent } from '@owlat/email-scanner';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { readMailMessageText } from '../lib/messageBody';
import { logInfo } from '../lib/runtimeLog';
import type { SenderHeuristics } from '../lib/validators/senderHeuristics';

/** The trust signals of one message, as returned by `getMessageForExtraction`. */
export interface MailTrustSignals {
	fromAddress: string;
	fromName?: string;
	replyToAddress?: string;
	subject: string;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
	dmarcResult?: string;
	dmarcOverride?: string;
	senderHeuristics?: SenderHeuristics;
}

/**
 * Why a message must not feed the knowledge graph, or null when it may. The
 * reason is a fixed token (never message content), safe to log.
 *
 * Refuses: a stored Spam/Quarantine verdict; a DMARC fail that no trusted
 * forwarder's ARC seal rescued; a From domain the ingest heuristics flagged as
 * spoofed or as a look-alike of a known contact's; and anything the content
 * scanner scores `suspicious` or `blocked` (the same scan hosted delivery uses
 * to fill a missing verdict, `deliveryPipeline/routing.ts#resolveSpamVerdict`).
 * The bar is lower than Spam routing on purpose: a legitimate message it
 * refuses only costs one message's worth of knowledge.
 */
export function knowledgeSkipReason(
	msg: MailTrustSignals,
	body: { text: string; html?: string }
): string | null {
	if (msg.spamVerdict === 'spam' || msg.spamVerdict === 'quarantine') {
		return `spam_verdict_${msg.spamVerdict}`;
	}
	if (msg.dmarcResult === 'fail' && msg.dmarcOverride !== 'arc') return 'dmarc_fail';
	if (msg.senderHeuristics?.isFromDomainSpoofed) return 'from_domain_spoofed';
	if (msg.senderHeuristics?.lookalikeOfContactDomain) return 'lookalike_contact_domain';
	const scan = scanContent(msg.subject, body.html || body.text, {
		from: msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress,
		replyTo: msg.replyToAddress,
	});
	if (scan.level !== 'clean') return `content_scan_${scan.level}`;
	return null;
}

/**
 * Load one message for knowledge extraction, or null when it is gone or
 * `knowledgeSkipReason` refuses it (the reason is logged). Callers must go
 * through this before resolving a sender contact, so a phishing sender never
 * becomes a CRM contact either.
 */
export async function loadExtractableMail(
	ctx: Pick<ActionCtx, 'runQuery' | 'storage'>,
	mailMessageId: Id<'mailMessages'>
) {
	const msg = await ctx.runQuery(internal.mail.migrationIndexing.getMessageForExtraction, {
		mailMessageId,
	});
	if (!msg) return null;
	const text = await readMailMessageText(ctx.storage, {
		textBodyInline: msg.textInline ?? undefined,
		textBodyStorageId: msg.textStorageId ?? undefined,
	});
	const reason = knowledgeSkipReason(msg, { text, html: msg.htmlInline ?? undefined });
	if (reason) {
		logInfo('[knowledge.mailScreen] skipped: untrusted message', { reason });
		return null;
	}
	return msg;
}
