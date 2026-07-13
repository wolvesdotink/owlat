/**
 * messageBody — the single module for reading a message's body out of the
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

import type { Doc, Id } from '../_generated/dataModel';
import { getOptional, getRequired } from './env';
import { openAtRest, sealAtRest, isSealedAtRest } from './atRestBodies';

// ── Sealed-at-rest shim (E8b) ────────────────────────────────────────────────
//
// E8b seals every stored body with the instance data key. Because E8a funnelled
// all readers through the accessors in this module, unsealing lives HERE and
// nowhere else: the sync accessors below still describe the row's raw shape
// (they cannot decrypt — Web Crypto is async), and each has an async `open*`
// sibling that returns the DECRYPTED body. A reader that needs plaintext calls
// the `open*` accessor; a reader that only needs to know a field is present
// (or writes it back untouched) keeps the sync one. `openAtRest` returns a
// legacy-plaintext value verbatim, so these accessors work on rows written
// before E8b and on rows the migration has not reached yet.

/** The instance body-at-rest secret (INSTANCE_SECRET). One lookup site. */
function atRestSecret(): string {
	return getRequired('INSTANCE_SECRET');
}

/** Seal a body for storage at rest. Writers call this before `db.insert`/`patch`.
 * REQUIRES `INSTANCE_SECRET` — used by the back-fill migration, which an operator
 * runs deliberately on a provisioned instance. Production write paths use
 * {@link sealBodyAtWrite}, which no-ops when no key is configured. */
export async function sealMessageBody(plaintext: string): Promise<string> {
	return sealAtRest(atRestSecret(), plaintext);
}

/**
 * Seal a body at a PRODUCTION WRITE site (insert/patch), gated on the instance
 * actually having a key: if `INSTANCE_SECRET` is not configured the plaintext is
 * returned unchanged. This is the honest derive-from-the-real-path rule — an
 * instance cannot seal without a key — and it keeps the mixed-tolerance contract
 * that readers already honour (`openMessageBody` passes plaintext through). Every
 * real deployment has `INSTANCE_SECRET` set, so new rows seal; unprovisioned
 * installs and the test harness (which does not stub the secret) store plaintext
 * exactly as before. A pre-sealed value is idempotently returned unchanged.
 */
export async function sealBodyAtWrite(plaintext: string): Promise<string> {
	const secret = getOptional('INSTANCE_SECRET');
	if (secret === undefined) return plaintext;
	return sealAtRest(secret, plaintext);
}

/** Optional-body sibling of {@link sealBodyAtWrite} for write sites whose column
 * is `string | undefined` — `undefined` stays `undefined` (column absent). */
export async function sealBodyAtWriteMaybe(
	plaintext: string | undefined
): Promise<string | undefined> {
	return plaintext === undefined ? undefined : sealBodyAtWrite(plaintext);
}

/**
 * Open a single stored body field. Passes legacy plaintext through unchanged —
 * and crucially reads `INSTANCE_SECRET` ONLY when the value is actually sealed,
 * so a pre-E8b / unmigrated deployment (or a test) with no secret configured
 * still reads plaintext bodies exactly as before.
 */
export async function openMessageBody(stored: string): Promise<string> {
	if (!isSealedAtRest(stored)) return stored;
	return openAtRest(atRestSecret(), stored);
}

async function openMaybe(stored: string | undefined): Promise<string | undefined> {
	return stored === undefined ? undefined : openMessageBody(stored);
}

/**
 * Fail-safe body open for the GDPR export bundle: like {@link openMessageBody},
 * but if a value LOOKS sealed yet fails to decrypt (a genuine tamper, OR a
 * never-sealed plaintext row whose text happens to be a structurally valid
 * envelope — attacker-craftable during the mixed-state window before the E8b
 * back-fill runs), it returns the stored string VERBATIM instead of throwing.
 * No plaintext leaks either way (a real ciphertext exports as ciphertext), and
 * one crafted inbound message can no longer DoS the whole export. Once the
 * back-fill has sealed every row this branch is unreachable.
 */
export async function openMessageBodyForExport(stored: string): Promise<string> {
	try {
		return await openMessageBody(stored);
	} catch {
		return stored;
	}
}

async function openMaybeLenient(stored: string | undefined): Promise<string | undefined> {
	return stored === undefined ? undefined : openMessageBodyForExport(stored);
}

/** Fail-safe sibling of {@link openInboundMessageBody} for the export bundle. */
export async function openInboundMessageBodyForExport(
	row: InboundMessageBodyFields
): Promise<InboundMessageBody> {
	return {
		text: await openMaybeLenient(row.textBody ?? undefined),
		html: await openMaybeLenient(row.htmlBody ?? undefined),
	};
}

// ── Seal-patch builders (E8b migration) ──────────────────────────────────────
//
// The E8b back-fill migration must READ each raw body column to re-seal it. So
// that the `check-body-access.sh` ratchet keeps its "body-field access lives
// only here" invariant, the field reads happen in THIS module and the migration
// receives an opaque patch of only-the-changed columns (it never names a body
// field). Each builder is idempotent: an already-sealed or empty value seals to
// itself and is dropped from the patch, so re-running the migration is a no-op.

/** Build the sealing patch for an `inboundMessages` row (only changed fields). */
export async function sealInboundBodyPatch(
	row: InboundMessageBodyFields
): Promise<{ textBody?: string; htmlBody?: string }> {
	const patch: { textBody?: string; htmlBody?: string } = {};
	if (row.textBody !== undefined && row.textBody !== null) {
		const next = await sealMessageBody(row.textBody);
		if (next !== row.textBody) patch.textBody = next;
	}
	if (row.htmlBody !== undefined && row.htmlBody !== null) {
		const next = await sealMessageBody(row.htmlBody);
		if (next !== row.htmlBody) patch.htmlBody = next;
	}
	return patch;
}

/** Build the sealing patch for a `mailMessages` inline row (only changed fields). */
export async function sealMailInlineBodyPatch(
	row: MailMessageInlineFields
): Promise<{ textBodyInline?: string; htmlBodyInline?: string }> {
	const patch: { textBodyInline?: string; htmlBodyInline?: string } = {};
	if (row.textBodyInline !== undefined) {
		const next = await sealMessageBody(row.textBodyInline);
		if (next !== row.textBodyInline) patch.textBodyInline = next;
	}
	if (row.htmlBodyInline !== undefined) {
		const next = await sealMessageBody(row.htmlBodyInline);
		if (next !== row.htmlBodyInline) patch.htmlBodyInline = next;
	}
	return patch;
}

/** The `content` JSON blob of a `unifiedMessages` row (sealed as one string). */
export interface UnifiedMessageContentField {
	content: string;
}

/** Build the sealing patch for a `unifiedMessages` row (only changed fields). */
export async function sealUnifiedContentPatch(
	row: UnifiedMessageContentField
): Promise<{ content?: string }> {
	const next = await sealMessageBody(row.content);
	return next !== row.content ? { content: next } : {};
}

/** The body columns of a `mailDrafts` row. `bodyHtml` is required; the text and
 * block variants are optional. */
export interface MailDraftBodyFields {
	bodyHtml: string;
	bodyText?: string;
	bodyBlocks?: string;
}

/** Build the sealing patch for a `mailDrafts` row (only changed fields). */
export async function sealMailDraftBodyPatch(
	row: MailDraftBodyFields
): Promise<{ bodyHtml?: string; bodyText?: string; bodyBlocks?: string }> {
	const patch: { bodyHtml?: string; bodyText?: string; bodyBlocks?: string } = {};
	const nextHtml = await sealMessageBody(row.bodyHtml);
	if (nextHtml !== row.bodyHtml) patch.bodyHtml = nextHtml;
	if (row.bodyText !== undefined) {
		const next = await sealMessageBody(row.bodyText);
		if (next !== row.bodyText) patch.bodyText = next;
	}
	if (row.bodyBlocks !== undefined) {
		const next = await sealMessageBody(row.bodyBlocks);
		if (next !== row.bodyBlocks) patch.bodyBlocks = next;
	}
	return patch;
}

/**
 * Read AND UNSEAL the `mailDrafts` body columns (E8b). Returns the same draft
 * with `bodyHtml` / `bodyText` / `bodyBlocks` decrypted (legacy plaintext passes
 * through). This is the choke point for reading a draft's body: the composer GET
 * and the send dispatcher both load a draft through here so the outgoing RFC822
 * is built from plaintext — never from a sealed envelope. Other draft fields are
 * returned untouched.
 */
export async function openMailDraftBody(draft: Doc<'mailDrafts'>): Promise<Doc<'mailDrafts'>> {
	return {
		...draft,
		bodyHtml: await openMessageBody(draft.bodyHtml),
		bodyText: await openMaybe(draft.bodyText),
		bodyBlocks: await openMaybe(draft.bodyBlocks),
	};
}

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

/**
 * Read AND UNSEAL the inline text/html body of an `inboundMessages` row (E8b).
 * The async sibling of {@link inboundMessageBody} — use it wherever plaintext is
 * needed. A legacy-plaintext row round-trips unchanged.
 */
export async function openInboundMessageBody(
	row: InboundMessageBodyFields
): Promise<InboundMessageBody> {
	return {
		text: await openMaybe(row.textBody ?? undefined),
		html: await openMaybe(row.htmlBody ?? undefined),
	};
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

/**
 * Read AND UNSEAL the inline text/html snippet of a `mailMessages` row (E8b).
 * The async sibling of {@link mailMessageInlineBody}. Does NOT fetch the blob —
 * use {@link readMailMessageText} for the full sealed body.
 */
export async function openMailMessageInlineBody(
	row: MailMessageInlineFields
): Promise<MailMessageInlineBody> {
	return { text: await openMaybe(row.textBodyInline), html: await openMaybe(row.htmlBodyInline) };
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
	// E8b: the inline snippet and the storage blob are both sealed at rest;
	// unseal on the way out. `openMessageBody` passes legacy plaintext through
	// unchanged, so a pre-E8b row or an unmigrated blob still resolves.
	if (row.textBodyInline) return openMessageBody(row.textBodyInline);
	if (row.textBodyStorageId) {
		const blob = await storage.get(row.textBodyStorageId);
		if (blob) return openMessageBody(await blob.text());
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

/**
 * Unseal AND parse the `unifiedMessages.content` blob (E8b). The whole JSON blob
 * is sealed as one string at rest, so unseal first, then parse. A legacy row's
 * `content` is not a sealed envelope, so `openMessageBody` returns it verbatim
 * and this behaves exactly like {@link parseUnifiedMessageContent}.
 */
export async function openUnifiedMessageContent(content: string): Promise<UnifiedMessageContent> {
	return parseUnifiedMessageContent(await openMessageBody(content));
}
