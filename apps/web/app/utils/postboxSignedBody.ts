/**
 * What the reader shows of a signed message, and whether its signature
 * verdict may stand beside it.
 *
 * The verdict says what it covers (`InboundSignatureInfo.scope`, recorded by
 * the ingest verifier):
 *   - `'clearsigned'`: one inline armor block (RFC 4880 §7) in the text/plain
 *     body, checked by `@owlat/shared/clearsignedBody`. Not the text around it,
 *     not an HTML alternative, not an attachment (an invite among them). The
 *     reader shows that block alone, from the
 *     text body as loaded (inline, or from storage when it is over the inline
 *     threshold), and holds the verdict back until that text is here.
 *   - `'mime'`: the first part of a root RFC 3156 `multipart/signed` with
 *     exactly two parts, which the verifier only accepts when the reader's own
 *     MIME walker agrees (`apps/api/convex/e2ee/signedMimeStructure.ts`), so
 *     it holds every body part the reader renders. The body renders as it
 *     always did, verdict beside it.
 * The attachment list cannot tell the two apart: a nameless signature part is
 * no attachment, and an unrelated `.asc` attachment is one.
 *
 * A verdict without a scope was written before the verifier recorded one,
 * and proves nothing about what it covers: back then a PGP/MIME verdict could
 * be valid with unsigned parts beside the signed one, forged clearsign armor
 * included. Such a verdict is never shown. The message reads as one with no
 * verdict ({@link signedBodyScopeOf} gives null), and the reader card drops the
 * verdict itself. Re-verifying from the raw message would restore it.
 *
 * Pure and module scope; the reader card supplies the loaded text.
 */
import {
	classifySecureMessage,
	extractClearsignedBlock,
	extractClearsignedText,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';

export type SignedBodyView =
	/** Render as the host classified it, verdict as given. */
	| { kind: 'passthrough' }
	/** The verdict needs the text body, which is not loaded yet. */
	| { kind: 'loading' }
	/**
	 * Show `text`, the signed block, and nothing else. `omitsContent` says the
	 * message holds more (text outside the block, an HTML alternative, any
	 * attachment).
	 */
	| { kind: 'signed'; text: string; omitsContent: boolean }
	/** Render the body, but without the verdict: nothing shown can be tied to it. */
	| { kind: 'withheld' };

/** What a shown verdict covers. */
export type SignedBodyScope = 'clearsigned' | 'mime';

/** The text body: on its way, failed to load, or here (null when there is none). */
export type SignedBodyText =
	| { state: 'loading' }
	| { state: 'failed' }
	| { state: 'loaded'; text: string | null };

export interface SignedBodyInput {
	/** The host's structural class (attachments plus any inline text body). */
	secureClass: SecureMessageClass;
	/** The scope of the verdict, or null when there is none that may be shown. */
	scope: SignedBodyScope | null;
	text: SignedBodyText;
	/** The message has parts beside the text: an HTML alternative or any attachment. */
	hasOtherParts: boolean;
}

/** Whether `text` holds anything beyond its clearsigned armor block. */
function hasTextOutsideBlock(text: string): boolean {
	const block = extractClearsignedBlock(text);
	if (block === null) return false;
	return text.replace(/\r\n/g, '\n').replace(block, '').trim() !== '';
}

/** The text's own clearsigned block, as the reader shows it, or null. */
function signedBlockOf(text: string): string | null {
	return classifySecureMessage({ textBody: text }) === 'pgp-clearsigned'
		? extractClearsignedText(text)
		: null;
}

/** The signed block alone, or the verdict withheld when the text has none. */
function signedView(text: string, hasOtherParts: boolean): SignedBodyView {
	const signed = signedBlockOf(text);
	if (signed === null) return { kind: 'withheld' };
	return { kind: 'signed', text: signed, omitsContent: hasOtherParts || hasTextOutsideBlock(text) };
}

export function resolveSignedBodyView(input: SignedBodyInput): SignedBodyView {
	const { secureClass, scope, text, hasOtherParts } = input;
	if (scope === 'mime') return { kind: 'passthrough' };
	if (scope === null) {
		// No verdict: an inline clearsigned body still shows only its block.
		if (secureClass !== 'pgp-clearsigned' || text.state !== 'loaded' || !text.text) {
			return { kind: 'passthrough' };
		}
		return signedView(text.text, hasOtherParts);
	}
	if (text.state === 'loading') return { kind: 'loading' };
	if (text.state === 'failed') return { kind: 'withheld' };
	return signedView(text.text ?? '', hasOtherParts);
}

/**
 * The scope {@link resolveSignedBodyView} reads off a message's verdict: null
 * for no verdict, and for a verdict written before scopes were recorded.
 */
export function signedBodyScopeOf(
	info: { isSigned?: boolean; scope?: SignedBodyScope } | undefined
): SignedBodyScope | null {
	return info?.isSigned === true ? (info.scope ?? null) : null;
}
