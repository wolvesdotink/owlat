/**
 * Mail CONTENT validators — the shapes a message, draft or snippet carries in
 * the database, as opposed to the per-user preferences in the sibling
 * `mailSettings.ts`.
 *
 * These are the single source for the schema, the mutation args and the
 * handlers, so a field can never be spelled two ways.
 */

import { v, type Infer } from 'convex/values';

// Attachment metadata embedded in raw .eml (mailMessages.attachments)
export const mailMessageAttachmentValidator = v.object({
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	contentId: v.optional(v.string()),
	partIndex: v.string(),
});

// Sealed-Mail validators (sealPolicyValidator / sealSkipReasonValidator /
// mailEncryptionInfoValidator) live in `../mail/sealPolicy.ts` for the ~500 LOC ratchet.

// Parsed List-Unsubscribe / List-Unsubscribe-Post target (mailMessages.unsubscribe).
// Parsed ONCE at ingest from the raw header block (see @owlat/shared/listUnsubscribe)
// so the reader can render the Unsubscribe chip without re-opening the raw .eml.
export const mailUnsubscribeValidator = v.object({
	httpUrl: v.optional(v.string()),
	mailtoUrl: v.optional(v.string()),
	oneClick: v.boolean(),
});

// Observed triage verb (mailTriageTallies.verb + the mail/triageTally args).
// Exactly the verbs that map onto a filter action a user would plausibly
// automate: archive → move to Archive, trash → delete, spam → move to Spam.
// Single source so the table, the recorder and the accept mutation cannot drift.
export const mailTriageVerbValidator = v.union(
	v.literal('archive'),
	v.literal('trash'),
	v.literal('spam')
);
export type MailTriageVerb = Infer<typeof mailTriageVerbValidator>;

// One typed variable declared on a snippet (mailSnippets.variables, plan idea
// 13). `token` is the name inside `{{…}}`; `source` says where the composer
// resolves it from at insertion — recipient facts and the sender identity come
// from what the composer already knows, `date` from the reader's clock, and
// `prompt` asks the person inserting it (that is the only source `label` is
// meaningful for). A body token with no declaration falls back to an implicit
// name table client-side, so every snippet saved before this field keeps
// working: absent = exactly today's `{{firstName}}` behaviour.
const mailSnippetVariableSourceValidator = v.union(
	v.literal('recipientFirstName'),
	v.literal('recipientFullName'),
	v.literal('recipientCompany'),
	v.literal('senderName'),
	v.literal('senderEmail'),
	v.literal('date'),
	v.literal('prompt'),
	// Saved replies (the `{{contact.lastName}}`-style variables).
	v.literal('recipientLastName'),
	v.literal('recipientEmail'),
	v.literal('senderFirstName'),
	v.literal('threadSubject')
);
export type MailSnippetVariableSource = Infer<typeof mailSnippetVariableSourceValidator>;

export const mailSnippetVariableValidator = v.object({
	token: v.string(),
	source: mailSnippetVariableSourceValidator,
	/** What the insert-time prompt asks for. Only read for `source: 'prompt'`. */
	label: v.optional(v.string()),
});

// Compose-draft attachment referencing Convex storage (mailDrafts.attachments)
export const mailDraftAttachmentValidator = v.object({
	storageId: v.id('_storage'),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	isInline: v.boolean(),
	contentId: v.optional(v.string()),
	// The file this blob was copied from (mail/attachExisting.ts), so attaching
	// the same Files row or mail attachment again is a no-op, not a second copy.
	copiedFrom: v.optional(
		v.object({
			source: v.union(v.literal('semanticFile'), v.literal('mailAttachment')),
			id: v.string(),
		})
	),
});

/**
 * A file a draft was opened to carry that the draft owes until it is attached
 * (mail/draftExpectedAttachments.ts, #1257): an RSVP's generated `.ics`, or one
 * attachment of a forwarded message. `owed` holds Send; `attached` names the
 * blob that settled it; `removed` is the person taking it out. A generated
 * file's text is kept only while it is owed.
 */
export const mailDraftExpectedAttachmentValidator = v.object({
	key: v.string(),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	source: v.union(
		v.object({ kind: v.literal('generated'), content: v.optional(v.string()) }),
		v.object({
			kind: v.literal('forward'),
			messageId: v.id('mailMessages'),
			partIndex: v.string(),
		})
	),
	state: v.union(v.literal('owed'), v.literal('attached'), v.literal('removed')),
	storageId: v.optional(v.id('_storage')),
});

/** What `drafts.create` is asked to owe: a generated file, or a message's attachments. */
export const expectedAttachmentRequestValidator = v.union(
	v.object({
		kind: v.literal('generated'),
		filename: v.string(),
		contentType: v.string(),
		content: v.string(),
	}),
	v.object({
		kind: v.literal('forward'),
		messageId: v.id('mailMessages'),
		// The parts to carry, as the composer picked them (all file parts when
		// absent); named so a message deleted meanwhile still owes them.
		parts: v.optional(v.array(v.object({ partIndex: v.string(), filename: v.string() }))),
	})
);

/**
 * Who may fetch an attachment share link's bytes (`mailAttachmentShares.scope`
 * and the mutation arg that narrows it).
 *
 *  - `anyone`  — the token alone opens it, which is what a link inside an
 *                outgoing message has to be: the recipient has no account here.
 *  - `mailbox` — the public route refuses the token; the file stays reachable
 *                only from inside the app, through the authorized sealed-blob
 *                proxy. Narrowing to this is a PARTIAL revoke.
 *
 * Semantics and the serving predicate live in
 * `@owlat/shared/attachmentShares` so the route and the client cannot drift.
 */
export const mailAttachmentShareScopeValidator = v.union(v.literal('anyone'), v.literal('mailbox'));

/**
 * Why a file was allowed to become shareable (`mailAttachmentShares.scanVerdict`).
 * A share is created only after the ClamAV gate the outbound send path uses has
 * run, so this records WHICH outcome opened the door: `clean` (scanned, came
 * back clean) or `skipped` (the scanner was absent or unreachable and the
 * pipeline's standing fail-open applied). `infected` is deliberately absent —
 * a confirmed verdict refuses creation, so no row can ever carry it.
 */
export const mailAttachmentShareScanValidator = v.union(v.literal('clean'), v.literal('skipped'));
