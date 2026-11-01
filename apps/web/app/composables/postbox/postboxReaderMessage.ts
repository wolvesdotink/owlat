/**
 * The shapes the Postbox thread reader works on: the message row it renders and
 * the live thread fields it branches on. Kept beside the reader's composables so
 * they and the reader share one definition; PostboxThreadReader.vue re-exports
 * the message row for its hosts.
 */
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';
import type { Placement } from '@owlat/shared/arrival';
import type { SenderHeuristics } from '~/utils/senderAuth';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import type { AttachmentIndexing } from '~/utils/attachmentIndexing';

/**
 * The full message row the reader renders (the list-row shape plus body /
 * verdict fields). Exported for hosts that pass rows through — the folder
 * view, the search preview, and the Today view's centered overlay.
 */
export type PostboxReaderMessage = {
	_id: string;
	mailboxId: string;
	threadId?: string;
	fromAddress: string;
	fromName?: string;
	toAddresses: string[];
	ccAddresses: string[];
	subject: string;
	snippet?: string;
	receivedAt: number;
	htmlBodyInline?: string;
	textBodyInline?: string;
	// Where a body over the inline threshold lives (thread rows), or the inline
	// body query's word for it while the reader renders from a list row (plan
	// 2.5; see usePostboxReaderOpenRow).
	htmlBodyStorageId?: string;
	textBodyStorageId?: string;
	hasBodyBlob?: boolean;
	bodyPending?: boolean;
	hasAttachments: boolean;
	/** What the assistant did with the files (hosted-MX capture); absent elsewhere. */
	attachmentIndexing?: AttachmentIndexing;
	attachments: Array<{
		filename: string;
		contentType: string;
		size: number;
		partIndex?: string;
		contentId?: string;
	}>;
	spamVerdict?: string;
	// Sender-authentication verdicts + DMARC inputs persisted at ingest (Sealed Mail
	// A1); absent on older rows, which the badge shows as "unknown", never a verdict.
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	dmarcPolicy?: string;
	envelopeFromDomain?: string;
	dkimSigningDomain?: string;
	// Inbound-auth override the backend applied (Sealed Mail A5): `'arc'` when a
	// trusted forwarder's validated ARC chain rescued a DMARC fail; `arcSealer`
	// names the honoured sealer so the badge can render "verified via forwarder".
	dmarcOverride?: string;
	arcSealer?: string;
	// Sender-impersonation heuristics (Sealed Mail A4): the badge's detail lines;
	// absent when nothing fired, so no false "clear".
	senderHeuristics?: SenderHeuristics;
	// Sealed Mail (E5): the inbound sealing record (`inboundEncryptionInfo`), only on
	// mail sealed between Owlat instances; else the structural badge takes over.
	inboundEncryptionInfo?: InboundEncryptionInfo;
	// F2: the signature verdict for PGP-signed mail verified at ingest; absent
	// for plaintext and pre-F1 rows (the badge falls back to "not verified").
	inboundSignatureInfo?: InboundSignatureInfo;
	flagSeen?: boolean;
	unsubscribe?: ListUnsubscribeTarget;
};

/** The open thread as the reader reads it off the thread page query. */
export type PostboxReaderThread = {
	_id: string;
	followUp?: {
		messageId: string;
		remindAt: number;
		dueAt?: number;
		waitingOn?: string;
	};
	// Muted conversation, its opt-in twin (alert me when they reply),
	// the pin and the transient back-from-snooze marker — all
	// checkable states in the thread ⋯ menu (mail/mute.ts,
	// mail/threadAlerts.ts, mail/pins.ts, mail/snooze.ts).
	mutedAt?: number;
	notifyOnReplyAt?: number;
	pinnedAt?: number;
	snoozeReturnedAt?: number;
	// The Priority placement (read on arrival §2.8), for "Why here?".
	arrival?: { placement: Placement };
	placementOverride?: { placement: Placement };
};
