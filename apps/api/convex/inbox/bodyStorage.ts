/**
 * Where a Team Inbox message's body is stored, and the bounded projections
 * derived from it.
 *
 * THE LIMIT. A Convex document is capped at 1 MiB, and the inbound route
 * accepts messages up to 10 MiB. An `inboundMessages` row carries far more
 * than the body — headers, attachment metadata, references, and over its life
 * the drafts, their revisions and the agent's step outputs — so the body parts
 * get a fixed share of the row ({@link INBOUND_INLINE_BODY_BUDGET_BYTES}) and
 * whatever does not fit goes to a sealed storage blob. Nothing is truncated:
 * the blob holds the whole part, and `lib/messageBodyInbound.ts` reads it back.
 *
 * MEASURED AS STORED. The budget is spent on the bytes the row will actually
 * hold: UTF-8, not UTF-16 code units (`'é'.length` is 1, its encoding is 2),
 * after at-rest sealing, which base64-encodes an AES-GCM box and so grows a
 * body by a third plus a fixed envelope. Text and HTML share the one budget,
 * because the document limit is on their sum.
 *
 * WHO DECIDES WHAT. Only an action can write a blob, so the ingest action
 * plans the split ({@link planInboundBodyStorage}) and stores the parts that
 * move (`inbox/receiveInbound.receiveStoringLargeBodies`). The mutation that
 * inserts the row still receives every part in full and derives the bounded
 * projections — the excerpt, the thread preview, the timeline mirror — from
 * them in one place ({@link inboundBodyColumns}, {@link inboundMirrorContent}).
 */

import type { Id } from '../_generated/dataModel';
import { htmlToPlainText } from '@owlat/shared/html';
import { truncateCodePoints } from '@owlat/shared/unicode';
import { utf8Bytes } from '../lib/bytes';
import { sealBodyAtWriteMaybe } from '../lib/messageBody';

/**
 * The stored bytes all body columns of one row may take together: the inline
 * parts plus, when a part moved out, the excerpt standing in for it. A quarter
 * of the document limit, leaving the rest to everything else the row carries
 * and accumulates.
 */
export const INBOUND_INLINE_BODY_BUDGET_BYTES = 256 * 1024;

/** The excerpt's length in code points. Enough for a reader to see what the
 * message is and for a handling rule to match on its opening; the full part is
 * one action away. */
export const INBOUND_BODY_EXCERPT_CODE_POINTS = 16 * 1024;

/** How much HTML the excerpt converts. The conversion is linear, but a 10 MiB
 * newsletter need not be converted whole to produce 16k characters of text. */
const EXCERPT_HTML_SOURCE_CHARS = 200_000;

/**
 * The most bytes a body of `utf8ByteLength` bytes can occupy once stored.
 *
 * Sealed, it is `atrest:1:<16-char IV>:<base64 of the ciphertext and its
 * 16-byte tag>` (`lib/atRestBodies.sealAtRest`); unsealed — an instance with no
 * INSTANCE_SECRET — it is the UTF-8 bytes themselves, which this also covers.
 * An upper bound on purpose: the envelope header is rounded up, so a change to
 * the prefix or version cannot quietly make the estimate too small. A test
 * holds it against the real sealer.
 */
export function storedBodyBytesUpperBound(utf8ByteLength: number): number {
	if (utf8ByteLength === 0) return 0;
	return 64 + 4 * Math.ceil((utf8ByteLength + 16) / 3);
}

/** Room kept for the excerpt when a part moves out: four UTF-8 bytes per code
 * point is the ceiling. */
const EXCERPT_RESERVE_BYTES = storedBodyBytesUpperBound(4 * INBOUND_BODY_EXCERPT_CODE_POINTS);

export interface InboundBodyPlan {
	isTextStored: boolean;
	isHtmlStored: boolean;
}

/**
 * Which parts go to storage.
 *
 * Both stay inline when they fit together — every message that fit before
 * this existed still does, so small mail is stored and read exactly as
 * before. Otherwise the LARGER part moves first, because a large HTML body
 * beside a short text part is the common case and the text part is the one
 * readers show; the smaller one follows only if what is left, plus room for
 * the excerpt, still does not fit.
 */
export function planInboundBodyStorage(input: {
	textBody?: string;
	htmlBody?: string;
}): InboundBodyPlan {
	const textCost = storedBodyBytesUpperBound(utf8Bytes(input.textBody ?? '').byteLength);
	const htmlCost = storedBodyBytesUpperBound(utf8Bytes(input.htmlBody ?? '').byteLength);
	if (textCost + htmlCost <= INBOUND_INLINE_BODY_BUDGET_BYTES) {
		return { isTextStored: false, isHtmlStored: false };
	}
	const room = INBOUND_INLINE_BODY_BUDGET_BYTES - EXCERPT_RESERVE_BYTES;
	const plan: InboundBodyPlan = { isTextStored: false, isHtmlStored: false };
	let inline = textCost + htmlCost;
	const byCost = [
		{ part: 'text' as const, cost: textCost },
		{ part: 'html' as const, cost: htmlCost },
	].sort((a, b) => b.cost - a.cost);
	for (const { part, cost } of byCost) {
		if (inline <= room || cost === 0) break;
		if (part === 'text') plan.isTextStored = true;
		else plan.isHtmlStored = true;
		inline -= cost;
	}
	return plan;
}

/** The part a reader shows: the text part when it has any, else the HTML. */
function readablePart(input: { textBody?: string; htmlBody?: string }): 'text' | 'html' | null {
	if (input.textBody?.trim()) return 'text';
	if (input.htmlBody) return 'html';
	return null;
}

/**
 * A bounded plain-text projection of a body: the text part, or the HTML
 * converted to text, cut at {@link INBOUND_BODY_EXCERPT_CODE_POINTS}. Used as
 * the row's `bodyExcerpt` and as the text of a large message's timeline mirror.
 */
export function buildInboundBodyExcerpt(input: {
	textBody?: string;
	htmlBody?: string;
}): string | undefined {
	const part = readablePart(input);
	if (part === null) return undefined;
	const source =
		part === 'text'
			? (input.textBody ?? '')
			: htmlToPlainText((input.htmlBody ?? '').slice(0, EXCERPT_HTML_SOURCE_CHARS));
	return truncateCodePoints(source, INBOUND_BODY_EXCERPT_CODE_POINTS);
}

/** The stored parts of one message, as the ingest action hands them over. */
export interface StoredBodyIds {
	textBodyStorageId?: Id<'_storage'>;
	htmlBodyStorageId?: Id<'_storage'>;
}

/**
 * The body columns of a new row, sealed. A part with a storage id is not
 * inlined; the excerpt is written only when the part a reader would show is
 * the one that moved, since an inline text part already is that stand-in.
 */
export async function inboundBodyColumns(
	input: { textBody?: string; htmlBody?: string } & StoredBodyIds
): Promise<
	{
		textBody?: string;
		htmlBody?: string;
		bodyExcerpt?: string;
	} & StoredBodyIds
> {
	const readable = readablePart(input);
	const isReadableStored =
		(readable === 'text' && input.textBodyStorageId !== undefined) ||
		(readable === 'html' && input.htmlBodyStorageId !== undefined);
	return {
		textBody:
			input.textBodyStorageId === undefined
				? await sealBodyAtWriteMaybe(input.textBody)
				: undefined,
		htmlBody:
			input.htmlBodyStorageId === undefined
				? await sealBodyAtWriteMaybe(input.htmlBody)
				: undefined,
		textBodyStorageId: input.textBodyStorageId,
		htmlBodyStorageId: input.htmlBodyStorageId,
		bodyExcerpt: isReadableStored
			? await sealBodyAtWriteMaybe(buildInboundBodyExcerpt(input))
			: undefined,
	};
}

/**
 * The largest mirror that carries the body in full. A message whose parts all
 * stayed inline fits well under it, except for text that JSON escaping blows
 * up (control characters become six-byte `\u` escapes).
 */
const MIRROR_FULL_CONTENT_MAX_BYTES = 256 * 1024;

/**
 * The `content` JSON of the contact-timeline mirror of an inbound email.
 *
 * The inbound row is the canonical body. A small message is mirrored whole,
 * exactly as before. A large one — a part in storage, or a mirror that would
 * not fit its own budget — is mirrored as a bounded projection: the excerpt as
 * `text`, no HTML, `isBodyTruncated`, and the `inboundMessageId` the full body
 * is read through (the Team Inbox, behind its owner/admin gate), so the timeline
 * never duplicates a large body into a second document.
 */
export function inboundMirrorContent(
	input: {
		textBody?: string;
		htmlBody?: string;
		subject: string;
		isSealed?: boolean;
		isSignatureValid?: boolean;
	} & StoredBodyIds,
	inboundMessageId: Id<'inboundMessages'>
): string {
	// `text`/`html` are the DECRYPTED plaintext when `isSealed` (D3): the
	// unified timeline + agent pipeline read real content, not ciphertext.
	const sealedFlags = input.isSealed
		? { isSealed: true, isSignatureValid: input.isSignatureValid }
		: {};
	const isStored = input.textBodyStorageId !== undefined || input.htmlBodyStorageId !== undefined;
	if (!isStored) {
		const full = JSON.stringify({
			text: input.textBody,
			html: input.htmlBody,
			subject: input.subject,
			...sealedFlags,
		});
		if (utf8Bytes(full).byteLength <= MIRROR_FULL_CONTENT_MAX_BYTES) return full;
	}
	return JSON.stringify({
		text: buildInboundBodyExcerpt(input),
		subject: input.subject,
		isBodyTruncated: true,
		inboundMessageId,
		...sealedFlags,
	});
}
