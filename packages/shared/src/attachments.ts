/**
 * Attachment limits — the single source of truth shared by client-side compose
 * gating and server-side enforcement (and the MTA/scanner caps), so the limit a
 * user sees in the composer can never diverge from what the backend enforces.
 */

/** Per-message compose limits (transactional API + the attachment panels). */
export const ATTACHMENT_COMPOSE_LIMITS = {
	/** Max number of attachments per message. */
	maxCount: 10,
	/** Max combined size of all attachments on one message, in bytes. */
	maxTotalBytes: 10 * 1024 * 1024,
} as const;

/**
 * Max size of a single attachment file, in bytes — the per-file upload cap, the
 * scanner's default `maxFileSize`, and the MTA submission wire cap all reference
 * this so they move together.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Hard cap on a WHOLE inbound message, in bytes: what the port-25 MX listener
 * advertises via EHLO SIZE and enforces on its DATA loop
 * (`apps/mta/src/bounce/server.ts`), which is the only way mail reaches either
 * inbound route.
 *
 * It lives beside the attachment ceilings because it bounds them: a limit above
 * what the wire can deliver is not a limit.
 */
export const MAX_INBOUND_MESSAGE_BYTES = 10 * 1024 * 1024;

/**
 * The largest single attachment a message at {@link MAX_INBOUND_MESSAGE_BYTES}
 * can actually carry. Attachment leaves travel base64 (4 wire bytes per 3 bytes
 * of content) and a message also carries headers, a body and the other parts'
 * overhead, so three quarters of the envelope is a generous upper bound.
 */
export const MAX_DELIVERABLE_ATTACHMENT_BYTES = Math.floor((MAX_INBOUND_MESSAGE_BYTES * 3) / 4);

/**
 * Per-attachment ceiling for AI INGESTION — the summary, the embedding and the
 * knowledge extraction that `semanticFiles.ingest` schedules.
 *
 * Deliberately below {@link MAX_ATTACHMENT_BYTES}: a file above this still
 * delivers, still appears in the message's attachment list and is still
 * downloadable out of the raw `.eml`. It is only not fed to a model, and the
 * message row records that it was not, so the reader can say so.
 *
 * The number is chosen to sit UNDER {@link MAX_DELIVERABLE_ATTACHMENT_BYTES} —
 * a ceiling above what the listener can deliver would be decoration, never a
 * gate (`__tests__/attachmentCeilings.test.ts` pins the relationship). Where it
 * sits inside that range is a cost judgement: extraction plus two completions
 * plus one embedding per knowledge entry is a fan-out with no cap of its own,
 * and a document worth summarising is rarely over a few megabytes, while a
 * multi-megabyte scan is mostly pixels the extractor cannot read anyway.
 */
export const MAX_AI_INGEST_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/**
 * Max size of a single file uploaded into the file library / media library, in
 * bytes — the ceiling shared by the upload modal copy, the client-side upload
 * guard, and the server-side `semanticFiles.create` / `mediaAssets.create`
 * checks, so the advertised limit can never diverge from what is enforced.
 */
export const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;

/** The library file ceiling expressed in whole MB, for user-facing copy. */
export const MAX_LIBRARY_FILE_MB = MAX_LIBRARY_FILE_BYTES / 1024 / 1024;
