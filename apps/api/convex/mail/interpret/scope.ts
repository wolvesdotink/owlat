/**
 * What of a message interpretation may read (SPEC §3 `signedScope`, §4 step 1):
 * `scopeForInterpretation(ctx, source)` loads the body through the body
 * accessors (`lib/messageBody*.ts`), applies the clearsigned scoping rules the
 * reader applies (`@owlat/shared/signedScope`), and says what it left out.
 *
 *   - A clearsigned body with a verdict: only the signed block is read, the
 *     text around it, an HTML alternative and the attachments are `omitted`.
 *   - An encrypted body (PGP or S/MIME, not opened here) is `undecryptable`:
 *     the run records a skip, and the brief says it could not read it.
 *   - Everything else: text and HTML as stored. Hidden HTML is removed FIRST
 *     by the security scan's own `stripHiddenContent` (`segmentScoped`), so
 *     the model never reads what the scan would strip, however a browser would
 *     parse the markup; `segmentMessage`'s visibility rules (with the scan's
 *     `styleHides`) stay as defence in depth. The segment source map then
 *     points into that stripped HTML, not the stored body; canonical offsets
 *     (what evidence stores) are unaffected.
 *
 * Isolate-safe (no `'use node'`): the loader is an internal query, the helper
 * runs in any action.
 */

import type { Doc } from '../../_generated/dataModel';
import { internalQuery, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { classifySecureMessage, isEncryptedClass } from '@owlat/shared/secureMessage';
import {
	resolveSignedBodyView,
	signedBodyScopeOf,
	type SignedBodyScope,
} from '@owlat/shared/signedScope';
import { segmentMessage, type SegmentedMessage } from '@owlat/shared/mailSegments';
import {
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { withStoredInlineBody } from '../../lib/messageBodyStore';
import {
	openMailMessageInlineBody,
	openMessageBody,
	readMailMessageText,
} from '../../lib/messageBody';
import { openInboundMessageBody } from '../../lib/messageBodyInbound';
import { readSealedBlobText } from '../../lib/sealedBlob';
import { styleHides } from '../../agent/steps/security_scan/hiddenStyle';
import { sourceVersionOf } from './sourceVersion';
import { loadInterpretSource } from './sources';
import { MAX_SCAN_INPUT_CHARS, stripHiddenContent } from '../../agent/steps/security_scan/patterns';

/**
 * The source row(s) the scope needs, as stored (bodies still sealed), with
 * the body fingerprint the reducer rechecks (`sourceVersion.ts`), read in the
 * same query so the two describe the same body.
 */
export const loadSourceForScope = internalQuery({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args) => {
		const source = args.source;
		const sourceVersion = await sourceVersionOf(ctx, source);
		if (source.kind === 'mail' || source.kind === 'outboundMail') {
			const row = await ctx.db.get(source.id);
			if (!row || sourceVersion === null) return null;
			return {
				kind: 'mail' as const,
				row: await withStoredInlineBody(ctx.db, row),
				sourceVersion,
			};
		}
		if (source.kind === 'inbound') {
			const row = await ctx.db.get(source.id);
			return row && sourceVersion !== null
				? { kind: 'inbound' as const, row, sourceVersion }
				: null;
		}
		const reply = await ctx.db.get(source.id);
		if (!reply) return null;
		// The text as the send was finalized (sources.ts), never the inbound
		// row's draft, which can change or be cleared after the send.
		const captured = await loadInterpretSource(ctx, source);
		if (!captured?.snapshot || sourceVersion === null) {
			return { kind: 'teamReplyMissing' as const };
		}
		return {
			kind: 'teamReply' as const,
			subject: captured.snapshot.subject,
			sealedText: captured.snapshot.text,
			sourceVersion,
		};
	},
});

export type ScopedMessage =
	| {
			ok: true;
			/** Body fingerprint the reducer rechecks (absent from the pure helpers). */
			sourceVersion?: string;
			text?: string;
			html?: string;
			subject: string;
			signedScope?: SignedBodyScope;
			/** What was left out: `outside_signed_block`, `html_alternative`, `attachments`, `body_unavailable`. */
			omitted: string[];
	  }
	| { ok: false; skipReason: 'undecryptable' }
	/** A team reply whose sent text was never captured: not interpreted. */
	| { ok: false; skipReason: 'ineligible'; detail: 'no_snapshot' };

/** The scoping rules over an opened body. Pure. */
export function scopeBody(input: {
	text?: string;
	html?: string;
	subject: string;
	attachments: ReadonlyArray<{ contentType: string }>;
	signatureInfo?: { isSigned?: boolean; scope?: SignedBodyScope };
}): ScopedMessage {
	const secureClass = classifySecureMessage({
		textBody: input.text,
		attachments: input.attachments.map((a) => ({ contentType: a.contentType })),
	});
	if (isEncryptedClass(secureClass)) return { ok: false, skipReason: 'undecryptable' };
	const scope = signedBodyScopeOf(input.signatureInfo);
	const view = resolveSignedBodyView({
		secureClass,
		scope,
		text: { state: 'loaded', text: input.text ?? null },
		hasOtherParts: !!input.html || input.attachments.length > 0,
	});
	if (view.kind === 'signed') {
		const omitted: string[] = [];
		if (view.omitsContent) omitted.push('outside_signed_block');
		if (input.html) omitted.push('html_alternative');
		if (input.attachments.length > 0) omitted.push('attachments');
		return {
			ok: true,
			text: view.text,
			subject: input.subject,
			signedScope: 'clearsigned',
			omitted,
		};
	}
	return {
		ok: true,
		...(input.text !== undefined ? { text: input.text } : {}),
		...(input.html !== undefined ? { html: input.html } : {}),
		subject: input.subject,
		...(view.kind === 'passthrough' && scope === 'mime' ? { signedScope: 'mime' as const } : {}),
		omitted: [],
	};
}

async function openMailRow(ctx: ActionCtx, row: Doc<'mailMessages'>) {
	const inline = await openMailMessageInlineBody(row);
	const text = inline.text ?? (await readMailMessageText(ctx.storage, row));
	let html = inline.html;
	if (html === undefined && row.htmlBodyStorageId) {
		html = (await readSealedBlobText(ctx.storage, row.htmlBodyStorageId)) || undefined;
	}
	return { text: text || undefined, html };
}

/** Load, open and scope one source message for interpretation. Null when it is gone. */
export async function scopeForInterpretation(
	ctx: ActionCtx,
	source: InterpretationSource
): Promise<ScopedMessage | null> {
	const loaded = await ctx.runQuery(internal.mail.interpret.scope.loadSourceForScope, { source });
	if (!loaded) return null;
	if (loaded.kind === 'teamReplyMissing') {
		return { ok: false, skipReason: 'ineligible', detail: 'no_snapshot' };
	}
	if (loaded.kind === 'teamReply') {
		return {
			ok: true,
			text: await openMessageBody(loaded.sealedText),
			subject: loaded.subject,
			sourceVersion: loaded.sourceVersion,
			omitted: [],
		};
	}
	if (loaded.kind === 'mail') {
		const row = loaded.row;
		const body = await openMailRow(ctx, row);
		const scoped = scopeBody({
			...body,
			subject: row.subject,
			attachments: row.attachments,
			signatureInfo: row.inboundSignatureInfo,
		});
		return scoped.ok ? { ...scoped, sourceVersion: loaded.sourceVersion } : scoped;
	}
	const row = loaded.row;
	const body = await openInboundMessageBody(row, ctx.storage);
	const text = body.text ?? (body.isComplete ? undefined : body.excerpt);
	const scoped = scopeBody({
		...(text !== undefined ? { text } : {}),
		...(body.html !== undefined ? { html: body.html } : {}),
		subject: row.subject,
		attachments: [],
	});
	if (!scoped.ok) return scoped;
	if (!body.isComplete) scoped.omitted.push('body_unavailable');
	return { ...scoped, sourceVersion: loaded.sourceVersion };
}

/** A segmentation plus what scoping could not read. */
export interface ScopedSegmentation {
	segmented: SegmentedMessage;
	/** The HTML ran past the hidden-content scanner's cap: the tail was not read. */
	isTruncated: boolean;
}

function wordsOf(text: string): string[] {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 2);
}

/**
 * Whether the text alternative says something the visible HTML does not:
 * more than a fifth of its words (at least three) are missing from it.
 */
export function isAlternativeAtOdds(text: string | undefined, visible: string): boolean {
	if (!text) return false;
	const words = wordsOf(text);
	if (words.length < 3) return false;
	const seen = new Set(wordsOf(visible));
	const missing = words.filter((w) => !seen.has(w)).length;
	return missing >= 3 && missing / words.length > 0.2;
}

/**
 * Segment a scoped message (stable ids). The body is CHOSEN before anything is
 * stripped: an HTML body is read as HTML even when nothing visible is left of
 * it (then there is nothing to claim), never swapped for the text alternative.
 * The HTML goes through the security scan's hidden-content strip first; a body
 * past the scanner's cap is reported (`isTruncated`, the run is partial), and
 * a text alternative that says more than the visible HTML marks the
 * segmentation uncertain (the run is partial too).
 */
export function segmentScoped(scoped: Extract<ScopedMessage, { ok: true }>): ScopedSegmentation {
	const isHtml = !!scoped.html && scoped.html.trim() !== '';
	if (!isHtml) {
		return {
			segmented: segmentMessage(
				{ text: scoped.text ?? null, html: null, subject: scoped.subject },
				{ styleHides }
			),
			isTruncated: false,
		};
	}
	const html = scoped.html as string;
	const stripped = stripHiddenContent(html, { html: true });
	const segmented = segmentMessage(
		// No text alternative: an HTML body whose visible content is empty stays empty.
		{ text: null, html: stripped.trim() ? stripped : '<p></p>', subject: scoped.subject },
		{ styleHides }
	);
	const isAtOdds = isAlternativeAtOdds(scoped.text, segmented.canonicalText);
	return {
		segmented: isAtOdds ? { ...segmented, uncertain: true } : segmented,
		isTruncated: html.length > MAX_SCAN_INPUT_CHARS,
	};
}

/** Hex SHA-256 of a string (Web Crypto: V8 and Node). */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The content revision of a segmented message: a hash of the canonical text
 * and the segment layout, so evidence offsets are only ever read against the
 * text they were taken from.
 */
export async function contentRevisionOf(segmented: SegmentedMessage): Promise<string> {
	const layout = segmented.segments.map((s) => `${s.id}:${s.kind}:${s.start}:${s.end}`).join(',');
	return (await sha256Hex(`${layout}\n${segmented.canonicalText}`)).slice(0, 32);
}
