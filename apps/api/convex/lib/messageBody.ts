/**
 * getMessageBody — the single accessor for reading a message's body out of the
 * three storage shapes Owlat keeps mail/message bodies in. Every direct reader
 * (agent context, knowledge extraction, mail AI / needs-reply / voice-profile,
 * timeline/export, preview builders) goes through here so there is ONE place
 * that knows how a body is laid out. The `scripts/check-body-access.sh` ratchet
 * fails the build on any direct body-field read outside this module.
 *
 * Why one accessor matters for Sealed Mail: E8b later seals ALL bodies at rest.
 * When every body read funnels through this module, the "unseal on read" hook
 * has a single choke point instead of ~30 scattered field accesses. This piece
 * (E8a) is the behaviour-neutral refactor that creates that choke point — it
 * changes no output; the proof is the existing api suite passing unmodified.
 *
 * The three shapes:
 *   1. inboundMessages — inline `textBody` / `htmlBody` string fields.
 *   2. mailMessages    — either an inline snippet (`textBodyInline` /
 *                        `htmlBodyInline`) or a storage blob
 *                        (`textBodyStorageId` / `htmlBodyStorageId`); large
 *                        bodies live in the blob, small ones inline.
 *   3. unifiedMessages — a JSON `content` string: `{ text, html, subject,
 *                        mediaUrl }`.
 */

import type { Id } from '../_generated/dataModel';

// ── Shape 1: inboundMessages inline bodies ───────────────────────────────────

/** The inline body fields on an `inboundMessages` row (both optional). `null`
 * is tolerated so projections that carry the body as `string | null` (e.g. the
 * agent context builder) can pass through the same accessor. */
export interface InboundMessageBodyFields {
	textBody?: string | null;
	htmlBody?: string | null;
}

/** Normalized body of an `inboundMessages` row. `null`/absent both collapse to
 * `undefined`; a present string is returned verbatim — this accessor never
 * fabricates or strips content. Destructure it so downstream narrowing works
 * (`const { text } = inboundMessageBody(row)`), rather than calling it inline
 * inside a conditional. */
export interface InboundMessageBody {
	text: string | undefined;
	html: string | undefined;
}

/** Read the inline text/html body of an `inboundMessages` row. */
export function inboundMessageBody(row: InboundMessageBodyFields): InboundMessageBody {
	return { text: row.textBody ?? undefined, html: row.htmlBody ?? undefined };
}

// ── Shape 2: mailMessages inline snippet + storage blob ──────────────────────

/** The inline body fields on a `mailMessages` row (both optional). Large
 * bodies are NOT here — they live in the `*BodyStorageId` blobs; use
 * {@link readMailMessageText} when the full body is required. */
export interface MailMessageInlineFields {
	textBodyInline?: string;
	htmlBodyInline?: string;
}

/** Normalized inline body of a `mailMessages` row. Values are the row's inline
 * fields verbatim (the blob, if any, is not fetched). */
export interface MailMessageInlineBody {
	text: string | undefined;
	html: string | undefined;
}

/** Read the inline text/html snippet of a `mailMessages` row WITHOUT fetching
 * the storage blob. This is what preview / excerpt / AI-context builders want:
 * a query can call it (queries cannot read blob contents) and it never does a
 * storage round-trip. */
export function mailMessageInlineBody(row: MailMessageInlineFields): MailMessageInlineBody {
	return { text: row.textBodyInline, html: row.htmlBodyInline };
}

/** Minimal storage reader — `ctx.storage` from an action or mutation. */
export interface BodyBlobStorageReader {
	get(storageId: Id<'_storage'>): Promise<Blob | null>;
}

/** The text-body fields of a `mailMessages` row, inline or blob. */
export interface MailMessageTextFields {
	textBodyInline?: string;
	textBodyStorageId?: Id<'_storage'>;
}

/**
 * Resolve the full plain-text body of a `mailMessages` row: the inline snippet
 * if present, otherwise the storage blob's contents, otherwise `''`. Requires
 * an action/mutation `ctx.storage` because blob contents are unreadable from a
 * query. This is the ONE place that turns a body-storage id into text — the
 * ratchet forbids `storage.get(...BodyStorageId)` anywhere else.
 */
export async function readMailMessageText(
	storage: BodyBlobStorageReader,
	row: MailMessageTextFields
): Promise<string> {
	if (row.textBodyInline) return row.textBodyInline;
	if (row.textBodyStorageId) {
		const blob = await storage.get(row.textBodyStorageId);
		if (blob) return await blob.text();
	}
	return '';
}

// ── Shape 3: unifiedMessages.content JSON ────────────────────────────────────

/** Parsed shape of the `unifiedMessages.content` JSON blob. */
export interface UnifiedMessageContent {
	text?: string;
	html?: string;
	subject?: string;
	mediaUrl?: string;
}

/**
 * Parse the `unifiedMessages.content` JSON string into its body shape. A
 * non-object or unparseable value falls back to treating the whole string as
 * the text body — matching the legacy `parseContent` / `safeParseContent`
 * helpers this consolidates. Never throws.
 */
export function parseUnifiedMessageContent(content: string): UnifiedMessageContent {
	try {
		const parsed: unknown = JSON.parse(content);
		if (parsed && typeof parsed === 'object') return parsed as UnifiedMessageContent;
		return { text: content };
	} catch {
		return { text: content };
	}
}
