/**
 * Personal-mail delivery pipeline: the decisions of the hosted MX delivery
 * mutation (`mail/delivery.ts:deliverToMailbox`), as data. The mutation loads
 * the mailbox, its filters, the instance settings and the sender status, and
 * makes every write; these functions say where the message goes and what the
 * insert, the post-delivery hook and the ingest action's answer carry.
 *
 * In the mutation's order:
 *   1. `filterDelivery`, once the mailbox's filters are loaded: the spam
 *      verdict and the user's manual filter outcome (`discard` skips).
 *   2. `routeDelivery`, once the instance settings are loaded: the DMARC/ARC
 *      verdict and whether the message is quarantined or moved by a filter
 *      (which tells sender status to keep out).
 *   3. `targetFolderRole`, once sender status answered: the system folder a
 *      message without a filter folder lands in.
 *   4. `deliveredMessageInput`, `postDeliveryHookArgs`, `deliveryAnswer`: what
 *      the insert, the scheduled hook and the ingest action get.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import { extractEmail } from '../../lib/emailAddress';
import type { SenderStatusAtDelivery } from '../arrival/hooks';
import type { SenderHeuristics } from '../senderHeuristics';
import type { SettledRouting } from './captureGate';
import type { MailboxDeliveryArgs } from './ingestFields';
import type { insertDeliveredMessage } from './insert';
import {
	type DmarcOverride,
	resolveDmarcRouting,
	resolveFilterOutcome,
	resolveSpamVerdict,
} from './routing';

export interface FilteredDelivery {
	/** The normalised `From:` address. */
	fromAddress: string;
	spamScore?: number;
	spamVerdict?: 'ham' | 'spam' | 'quarantine';
	filter: ReturnType<typeof resolveFilterOutcome>;
}

/**
 * Fill in a missing spam verdict (an MTA-supplied one always wins) and reduce
 * the user's filters to a delivery decision. A `discard` in `filter` means the
 * message is dropped without writing anything.
 */
export function filterDelivery(
	args: MailboxDeliveryArgs,
	filters: Doc<'mailFilters'>[]
): FilteredDelivery {
	const fromAddress = extractEmail(args.from);
	const { spamScore, spamVerdict } = resolveSpamVerdict({
		subject: args.subject,
		bodyHtmlInline: args.htmlBodyInline,
		bodyTextInline: args.textBodyInline,
		from: args.from,
		replyTo: args.replyTo,
		spamScore: args.spamScore,
		spamVerdict: args.spamVerdict,
	});
	const filter = resolveFilterOutcome(filters, {
		from: fromAddress,
		to: args.to.map(extractEmail),
		cc: args.cc.map(extractEmail),
		subject: args.subject,
		bodyText: args.textBodyInline,
		bodyHtml: args.htmlBodyInline,
		size: args.rawSize,
		hasAttachment: args.attachments.length > 0,
	});
	return { fromAddress, spamScore, spamVerdict, filter };
}

export interface MailboxRouting extends FilteredDelivery {
	dmarcOverride?: DmarcOverride;
	arcSealer?: string;
	/** Spam verdict, infected attachment or an enforced DMARC fail. */
	isQuarantined: boolean;
	/** A filter or the quarantine already decided the folder. */
	isMovedByFilter: boolean;
}

/**
 * Settle the ARC rescue and the DMARC quarantine decision (RFC 8617 / RFC
 * 7489) against the operator's trusted-forwarder allow-list.
 */
export function routeDelivery(
	args: MailboxDeliveryArgs,
	filtered: FilteredDelivery,
	trustedArcForwarders: string[] | undefined
): MailboxRouting {
	const { dmarcOverride, arcSealer, isDmarcQuarantine } = resolveDmarcRouting(
		args,
		trustedArcForwarders
	);
	const isQuarantined =
		filtered.spamVerdict === 'spam' || args.virusVerdict === 'infected' || isDmarcQuarantine;
	return {
		...filtered,
		dmarcOverride,
		arcSealer,
		isQuarantined,
		isMovedByFilter: isQuarantined || filtered.filter.isTrashed || !!filtered.filter.folderId,
	};
}

/** The system folder for a message no filter moved into a folder of its own. */
export function targetFolderRole(
	routing: MailboxRouting,
	senderStatus: SenderStatusAtDelivery
): 'spam' | 'trash' | 'archive' | 'inbox' {
	if (routing.isQuarantined) return 'spam';
	if (routing.filter.isTrashed) return 'trash';
	return senderStatus?.filedTo ?? 'inbox';
}

/** The row `insertDeliveredMessage` writes for this delivery. */
export function deliveredMessageInput(
	args: MailboxDeliveryArgs,
	routing: MailboxRouting,
	target: {
		mailbox: Doc<'mailboxes'>;
		folder: Doc<'mailFolders'>;
		senderStatus: SenderStatusAtDelivery;
		senderHeuristics: SenderHeuristics | undefined;
	}
): Parameters<typeof insertDeliveredMessage>[1] {
	const { filter } = routing;
	return {
		mailbox: target.mailbox,
		folder: target.folder,
		rawStorageId: args.rawStorageId,
		rawSize: args.rawSize,
		from: args.from,
		to: args.to,
		cc: args.cc,
		bcc: args.bcc,
		replyTo: args.replyTo,
		subject: args.subject,
		textBodyInline: args.textBodyInline,
		textBodyStorageId: args.textBodyStorageId,
		htmlBodyInline: args.htmlBodyInline,
		htmlBodyStorageId: args.htmlBodyStorageId,
		snippet: args.snippet,
		searchBody: args.searchBody,
		messageId: args.messageId,
		inReplyTo: args.inReplyTo,
		references: args.references,
		receivedAt: args.receivedAt,
		attachments: args.attachments,
		flagSeen: filter.flagSeen || target.senderStatus?.status === 'auto_archive',
		flagFlagged: filter.flagFlagged,
		labelIds: filter.labelIds,
		spamScore: routing.spamScore,
		spamVerdict: routing.spamVerdict,
		virusVerdict: args.virusVerdict,
		spfResult: args.spfResult,
		dkimResult: args.dkimResult,
		dmarcResult: args.dmarcResult,
		dmarcPolicy: args.dmarcPolicy,
		dmarcOverride: routing.dmarcOverride,
		arcSealer: routing.arcSealer,
		envelopeFromDomain: args.envelopeFromDomain,
		dkimSigningDomain: args.dkimSigningDomain,
		senderHeuristics: target.senderHeuristics,
		inboundEncryptionInfo: args.inboundEncryptionInfo,
		inboundSignatureInfo: args.inboundSignatureInfo,
		unsubscribe: args.unsubscribe,
		pinnedSection: filter.pinnedSection,
		countUsedBytes: true,
		inboundOrigin: 'mx',
	};
}

/** `mail/deliveryHooks.runPostDelivery`'s arguments: forwarding and vacation. */
export function postDeliveryHookArgs(
	args: MailboxDeliveryArgs,
	routing: MailboxRouting,
	mailbox: Doc<'mailboxes'>,
	messageId: Id<'mailMessages'>
) {
	return {
		mailboxId: mailbox._id,
		mailboxAddress: mailbox.address,
		messageId,
		fromAddress: routing.fromAddress,
		// SMTP envelope sender (RFC 5321 MAIL FROM; `''` for a bounce): vacation
		// replies skip bounces off it (RFC 3834 §2) and are addressed to it (§4).
		returnPath: args.returnPath,
		// So the vacation auto-reply threads onto this message (RFC 3834 §3.1.5/6).
		triggeringMessageId: args.messageId,
		triggeringReferences: args.references,
		subject: args.subject,
		bodyText: args.textBodyInline,
		bodyHtml: args.htmlBodyInline,
		// Raw headers: the hook re-checks Auto-Submitted / List-Id / Precedence.
		headers: args.antiLoopHeaders ?? {},
		// Filter-level "Forward to…" targets, beside account-level forwarding.
		filterForwardTo: routing.filter.filterForwardTo,
	};
}

/**
 * The ingest action's answer. `dmarcOverride` travels back so its capture step
 * gates on the SAME settled verdict this delivery routed on, rather than
 * re-deciding the ARC rescue against a second read of the allow-list.
 */
export function deliveryAnswer(
	messageId: Id<'mailMessages'>,
	routing: MailboxRouting,
	folder: Doc<'mailFolders'>
): { messageId: Id<'mailMessages'>; dmarcOverride?: DmarcOverride } & SettledRouting {
	return {
		messageId,
		dmarcOverride: routing.dmarcOverride,
		...(folder.role ? { folderRole: folder.role } : {}),
		...(routing.spamVerdict ? { spamVerdict: routing.spamVerdict } : {}),
	};
}
