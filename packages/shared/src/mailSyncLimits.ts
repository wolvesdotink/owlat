/**
 * Raw IMAP message ceiling, including MIME encoding and attachments.
 * The HTTP action buffers and seals in a 64 MiB isolate. Keep headroom for
 * plaintext, ciphertext, Blob storage, request chunks, and runtime overhead.
 */
export const MAIL_SYNC_MAX_RAW_MESSAGE_BYTES = 8 * 1024 * 1024;
