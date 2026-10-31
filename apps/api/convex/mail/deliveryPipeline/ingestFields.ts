/**
 * Personal-mail delivery pipeline — the argument fields every ingest entry
 * point shares.
 *
 * Five Convex functions land a message through `insertDeliveredMessage`: the
 * hosted MX action and mutation (`mail/delivery.ts`), the IMAP-sync action and
 * mutation (`mail/external/delivery.ts`) and the archive import mutation
 * (`mail/archiveImport.ts`). They used to spell these validators out one by
 * one, so a new message field had to be added to five argument blocks. They
 * are plain records of validators, spread into each `args`, so each function
 * keeps its own flat argument shape.
 */

import { v, type ObjectType } from 'convex/values';
import { deliveredEnvelopeFields } from '@owlat/worker-protocol/fields';
import { inboundEncryptionInfoValidator } from '../../e2ee/inboundSeal';
import { inboundSignatureInfoValidator } from '../../e2ee/inboundSignature';
import { spamVerdictValidator } from '../../lib/convexValidators';
import { virusVerdictValidator } from '../../lib/literalValidators';
import { mailUnsubscribeValidator } from '../../lib/validators/mailContent';
import { mailMessageStoredPartsValidator } from '../../schema/mailComposition';

/**
 * The addressing and identity headers of a delivered message. The mail-sync
 * worker sends them to `ingestExternalRaw`, so the worker wire contract
 * declares them.
 */
export { deliveredEnvelopeFields };

/**
 * The stored form of a message's body and raw source, as the insert mutations
 * receive it: each body either inline or already split into a blob, plus the
 * staged raw `.eml`. The ingest actions compute these, so they take the
 * envelope fields only.
 */
export const storedBodyFields = {
	textBodyInline: v.optional(v.string()),
	textBodyStorageId: v.optional(v.id('_storage')),
	htmlBodyInline: v.optional(v.string()),
	htmlBodyStorageId: v.optional(v.id('_storage')),
	snippet: v.optional(v.string()),
	// Deep-search excerpt (idea 32). Always sent by the ingest action; the
	// insert step drops it unless the instance opted in.
	searchBody: v.optional(v.string()),
	receivedAt: v.number(),
	rawStorageId: v.id('_storage'),
	rawSize: v.number(),
};

/**
 * The hosted MX delivery mutation's arguments (`mail/delivery.ts:
 * deliverToMailbox`): what the ingest action staged and verified for one
 * message. Here so the delivery decisions (`./mailboxDecision.ts`) can name the
 * type without importing the function module.
 */
export const mailboxDeliveryFields = {
	...deliveredEnvelopeFields,
	...storedBodyFields,
	antiLoopHeaders: v.optional(v.record(v.string(), v.string())),
	// Parsed List-Unsubscribe target (extracted at ingest by the caller).
	unsubscribe: v.optional(mailUnsubscribeValidator),
	recipientAddress: v.string(),
	// SMTP envelope sender (RFC 5321 MAIL FROM); `''` for a bounce/DSN null
	// sender. Passed to the post-delivery hook so vacation auto-replies skip
	// bounces (RFC 3834 §2) keyed off the envelope, not the `From:` header.
	returnPath: v.optional(v.string()),
	spamScore: v.optional(v.number()),
	spamVerdict: v.optional(spamVerdictValidator),
	virusVerdict: v.optional(virusVerdictValidator),
	spfResult: v.optional(v.string()),
	dkimResult: v.optional(v.string()),
	dmarcResult: v.optional(v.string()),
	dmarcPolicy: v.optional(v.string()),
	// Verified inbound ARC verdict (RFC 8617, Sealed Mail A5). Rescues a DMARC
	// fail when a TRUSTED forwarder sealed a valid chain attesting the original
	// passed. All optional (older MTA ⇒ absent ⇒ no rescue).
	arcCv: v.optional(v.string()),
	arcSealerDomain: v.optional(v.string()),
	arcAttestsOriginalPass: v.optional(v.boolean()),
	// DMARC alignment inputs (envelope MAIL FROM domain + DKIM d= domain),
	// stored beside the verdicts on `mailMessages`. Both optional.
	envelopeFromDomain: v.optional(v.string()),
	dkimSigningDomain: v.optional(v.string()),
	// Sealed Mail: the inbound unsealing outcome, computed by the
	// ingest action before this mutation. Present only for a message that
	// arrived sealed; the body args above already hold the RESTORED plaintext
	// when it decrypted. Absent ⇒ a plaintext message (unchanged fast path).
	inboundEncryptionInfo: v.optional(inboundEncryptionInfoValidator),
	// Inbound signature verdict, computed by the ingest action for a
	// SIGNED-but-not-encrypted message. Data only — never affects routing.
	inboundSignatureInfo: v.optional(inboundSignatureInfoValidator),
	// Plan 3.5: the attachment leaves the ingest action stored one blob each,
	// recorded against the raw blob once the row is in. Absent from an older
	// action (and when staging failed): the reader then uses the raw `.eml`.
	storedParts: v.optional(mailMessageStoredPartsValidator),
};

export type MailboxDeliveryArgs = ObjectType<typeof mailboxDeliveryFields>;
