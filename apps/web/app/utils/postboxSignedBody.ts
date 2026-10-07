/**
 * What the reader shows of a message whose signature verdict speaks for its
 * TEXT part, and which verdict may stand beside it.
 *
 * An inline clearsigned body (RFC 4880 §7) signs one armor block in the
 * text/plain part. The ingest verifier checks that block and nothing else
 * (`@owlat/shared/clearsignedBody`): not text around it, not an HTML
 * alternative. So the reader shows that block alone, and the verdict stands
 * only beside it. Two things used to break that:
 *   - a text body over the inline threshold lives in storage, so the inline
 *     classification saw no text, found no block, and the whole body rendered;
 *   - with the text in storage, an HTML alternative rendered instead.
 * The classification therefore runs on the text body as loaded, inline or
 * from storage, and the verdict is held back until that text is here.
 *
 * PGP/MIME (`multipart/signed`) and S/MIME are not this path: their structure
 * comes from the attachment list and their body renders as it always did.
 * A verified PGP/MIME verdict requires `multipart/signed` at the message root,
 * whose signed first part holds every body part the reader shows.
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
	/** Not a text-part signature: render as the host classified it. */
	| { kind: 'passthrough' }
	/** A text-part verdict, but the text body is not loaded yet. */
	| { kind: 'loading' }
	/**
	 * Show `text`, the signed block, and nothing else. `omitsContent` says the
	 * message holds more (text outside the block, or an HTML alternative).
	 */
	| { kind: 'signed'; text: string; omitsContent: boolean }
	/** A verdict with no signed block in the text to tie it to: render the body, drop the verdict. */
	| { kind: 'unbound' };

export interface SignedBodyInput {
	/** The host's structural class (attachments plus any inline text body). */
	secureClass: SecureMessageClass;
	/** The message carries an inbound signature verdict (any status). */
	hasVerdict: boolean;
	/** The text body as loaded; undefined while it is still on its way, null when there is none. */
	text: string | null | undefined;
	/** The message has an HTML body beside the text. */
	hasHtml: boolean;
}

/**
 * Whether a message's signature verdict, if any, is about its text part: the
 * attachment list shows no MIME signature or encryption structure. Only these
 * messages need their text body to decide what may be shown.
 */
export function isTextPartSignature(secureClass: SecureMessageClass): boolean {
	return secureClass === 'none' || secureClass === 'pgp-clearsigned';
}

/** Whether `text` holds anything beyond its clearsigned armor block. */
function hasTextOutsideBlock(text: string): boolean {
	const block = extractClearsignedBlock(text);
	if (block === null) return false;
	return text.replace(/\r\n/g, '\n').replace(block, '').trim() !== '';
}

export function resolveSignedBodyView(input: SignedBodyInput): SignedBodyView {
	if (!isTextPartSignature(input.secureClass)) return { kind: 'passthrough' };
	// No verdict and no block found in an inline text: ordinary mail, no claim.
	if (!input.hasVerdict && input.secureClass === 'none') return { kind: 'passthrough' };
	if (input.text === undefined) return { kind: 'loading' };

	const text = input.text ?? '';
	const signed =
		classifySecureMessage({ textBody: text }) === 'pgp-clearsigned'
			? extractClearsignedText(text)
			: null;
	if (signed === null) return input.hasVerdict ? { kind: 'unbound' } : { kind: 'passthrough' };
	return {
		kind: 'signed',
		text: signed,
		omitsContent: input.hasHtml || hasTextOutsideBlock(text),
	};
}
