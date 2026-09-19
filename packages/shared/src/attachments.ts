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
 * Per-attachment ceiling for AI INGESTION — the summary, the embedding and the
 * knowledge extraction that `semanticFiles.ingest` schedules.
 *
 * Deliberately below {@link MAX_ATTACHMENT_BYTES}: a file above this still
 * delivers, still appears in the message's attachment list and is still
 * downloadable out of the raw `.eml`. It is only not fed to a model. The ceiling
 * exists because inbound mail is reachable by any sender, and the real cost per
 * captured part is two LLM completions plus one embedding per extracted
 * knowledge entry — a fan-out with no cap of its own.
 */
export const MAX_AI_INGEST_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Max size of a single file uploaded into the file library / media library, in
 * bytes — the ceiling shared by the upload modal copy, the client-side upload
 * guard, and the server-side `semanticFiles.create` / `mediaAssets.create`
 * checks, so the advertised limit can never diverge from what is enforced.
 */
export const MAX_LIBRARY_FILE_BYTES = 50 * 1024 * 1024;

/** The library file ceiling expressed in whole MB, for user-facing copy. */
export const MAX_LIBRARY_FILE_MB = MAX_LIBRARY_FILE_BYTES / 1024 / 1024;
