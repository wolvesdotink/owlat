/**
 * What the reader shows of a signed message, and whether its signature
 * verdict may stand beside it.
 *
 * The verdict says what it covers (`InboundSignatureInfo.scope`, recorded by
 * the ingest verifier):
 *   - `'clearsigned'`: one inline armor block (RFC 4880 §7) in the text/plain
 *     body, checked by `@owlat/shared/clearsignedBody`. Not the text around it
 *     and not an HTML alternative. The reader shows that block alone, from the
 *     text body as loaded (inline, or from storage when it is over the inline
 *     threshold), and holds the verdict back until that text is here.
 *   - `'mime'`: the first part of a root RFC 3156 `multipart/signed` with
 *     exactly two parts (`@owlat/mail-canon`'s extractor rejects anything
 *     else), which holds every body part the reader renders. The body renders
 *     as it always did, verdict beside it.
 * The attachment list cannot tell the two apart: a nameless signature part is
 * no attachment, and an unrelated `.asc` attachment is one.
 *
 * Rows verified before the scope was recorded fall back to the attachment
 * list, and where that and the text disagree (a `.asc` attachment beside a
 * clearsigned block) the verdict is withheld: the reader cannot know which of
 * the two it is about.
 *
 * Pure and module scope; the reader card supplies the loaded text.
 */
import {
	classifySecureMessage,
	extractClearsignedBlock,
	extractClearsignedText,
	isEncryptedClass,
	type SecureMessageClass,
} from '@owlat/shared/secureMessage';

export type SignedBodyView =
	/** Render as the host classified it, verdict as given. */
	| { kind: 'passthrough' }
	/** The verdict needs the text body, which is not loaded yet. */
	| { kind: 'loading' }
	/**
	 * Show `text`, the signed block, and nothing else. `omitsContent` says the
	 * message holds more (text outside the block, or an HTML alternative).
	 */
	| { kind: 'signed'; text: string; omitsContent: boolean }
	/** Render the body, but without the verdict: nothing shown can be tied to it. */
	| { kind: 'withheld' };

/** The verdict's scope; `'unrecorded'` on a row verified before it was stored. */
export type SignedBodyScope = 'clearsigned' | 'mime' | 'unrecorded';

export interface SignedBodyInput {
	/** The host's structural class (attachments plus any inline text body). */
	secureClass: SecureMessageClass;
	/** The message's signature verdict scope, or null when it has no verdict. */
	scope: SignedBodyScope | null;
	/** The text body as loaded; undefined while it is still on its way, null when there is none. */
	text: string | null | undefined;
	/** The message has an HTML body beside the text. */
	hasHtml: boolean;
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
function signedView(text: string, hasHtml: boolean): SignedBodyView {
	const signed = signedBlockOf(text);
	if (signed === null) return { kind: 'withheld' };
	return { kind: 'signed', text: signed, omitsContent: hasHtml || hasTextOutsideBlock(text) };
}

export function resolveSignedBodyView(input: SignedBodyInput): SignedBodyView {
	const { secureClass, scope, hasHtml } = input;
	if (scope === 'mime') return { kind: 'passthrough' };
	if (scope === null) {
		// No verdict: an inline clearsigned body still shows only its block.
		if (secureClass !== 'pgp-clearsigned') return { kind: 'passthrough' };
		return input.text ? signedView(input.text, hasHtml) : { kind: 'passthrough' };
	}
	// An unrecorded scope under a structure no clearsigned verdict comes with.
	if (scope === 'unrecorded' && (isEncryptedClass(secureClass) || secureClass === 'smime-signed')) {
		return { kind: 'passthrough' };
	}
	if (input.text === undefined) return { kind: 'loading' };
	const text = input.text ?? '';
	if (scope === 'unrecorded' && secureClass === 'pgp-signed') {
		// A signature attachment: PGP/MIME, unless the text carries a block too.
		return signedBlockOf(text) === null ? { kind: 'passthrough' } : { kind: 'withheld' };
	}
	return signedView(text, hasHtml);
}

/** The scope {@link resolveSignedBodyView} reads off a message's verdict. */
export function signedBodyScopeOf(
	info: { isSigned?: boolean; scope?: 'clearsigned' | 'mime' } | undefined
): SignedBodyScope | null {
	if (info?.isSigned !== true) return null;
	return info.scope ?? 'unrecorded';
}
