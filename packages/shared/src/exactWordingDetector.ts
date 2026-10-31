/**
 * Read on arrival: the pre-gist exact-wording detector.
 *
 * A gist is two verbatim sentences picked by a model. For some mail the
 * wording itself is what matters, and two picked sentences can mislead:
 * payment instructions and changed bank details, legal or contractual
 * notices, invoices that carry payment details. A message this flags is read
 * in full instead of gisted or counted (`arrivalDepth.ts` rows 8, 10 and 11),
 * so the existing exact-wording machinery covers it exactly as today, and it
 * is never placed in the digest or updates (`arrivalPlacement.ts`).
 *
 * Deterministic and conservative: fixed English and German patterns over the
 * subject and the first {@link SCAN_CHARS} characters of the text, and an IBAN
 * only counts when its mod-97 checksum holds. Every pattern is linear (no
 * nested unbounded quantifiers), so attacker-controlled mail cannot make it
 * slow. Pure.
 */

/** What the detector found; empty means the message may be gisted. */
export type ExactWordingKind = 'payment_details' | 'legal_notice' | 'invoice_payment';

/** Characters of the text scanned: payment and legal wording sits near the top. */
const SCAN_CHARS = 20_000;

/** A phrase as a whole-word, case-insensitive, Unicode-aware pattern. */
function phrase(source: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'iu');
}

const PAYMENT_PHRASES = [
	// English
	phrase(
		'(?:new|changed|updated|revised|amended) (?:bank|banking|account|payment) (?:details|information|info)'
	),
	phrase('(?:bank|banking|account) details (?:have|has) (?:changed|been updated)'),
	phrase('(?:payment|wire|transfer|remittance) instructions'),
	phrase('(?:account|acct\\.?) (?:number|no\\.?)\\s?:?\\s?\\d+'),
	phrase('(?:sort code|routing number|aba number)'),
	phrase('(?:bic|swift)(?: code)?\\s?:\\s?[a-z]{6}[a-z0-9]{2}(?:[a-z0-9]{3})?'),
	// German
	phrase(
		'(?:neue|geänderte|aktualisierte) (?:bankverbindung|kontoverbindung|bankdaten|kontodaten)'
	),
	phrase('(?:bankverbindung|kontoverbindung|bankdaten) (?:hat|haben) sich geändert'),
	phrase('(?:zahlungsanweisung|zahlungsanweisungen|überweisungsdaten)'),
	phrase('kontonummer\\s?:?\\s?\\d+'),
	phrase('bitte (?:überweise|überweisen sie)'),
];

const LEGAL_PHRASES = [
	// English
	phrase('notice of (?:termination|default|cancellation|breach|eviction)'),
	phrase('(?:termination|cancellation) of (?:your|the|our) (?:contract|agreement|lease|tenancy)'),
	phrase('(?:we are|we will be) terminating (?:your|the) (?:contract|agreement|account)'),
	phrase(
		'(?:changes|updates|amendments) to (?:our|the) (?:terms|terms of service|terms and conditions|privacy policy|agreement)'
	),
	phrase('(?:updated|revised|new) (?:terms of service|terms and conditions|privacy policy)'),
	phrase('(?:final notice|legal notice|formal notice|debt collection|collections agency)'),
	phrase('(?:court|tribunal) (?:order|summons|hearing|date)'),
	phrase('(?:lawsuit|subpoena|injunction)'),
	// German
	phrase('(?:kündigung|kündigungsbestätigung|kündigungsfrist)'),
	phrase('(?:wir|hiermit) (?:kündigen|kündige)'),
	phrase(
		'änderung(?:en)? (?:der|unserer|unsere) (?:agb|nutzungsbedingungen|geschäftsbedingungen|datenschutzerklärung|vertragsbedingungen)'
	),
	phrase('(?:neue|geänderte|aktualisierte) (?:agb|nutzungsbedingungen|geschäftsbedingungen)'),
	phrase('(?:mahnung|letzte mahnung|mahnbescheid|inkasso|zahlungsverzug|vollstreckung)'),
	// Not plain "Gericht", which is also a dish.
	phrase(
		'(?:amtsgericht|landgericht|oberlandesgericht|gerichtsverfahren|gerichtstermin|gerichtliche[nrs]?|vor gericht|klage|klageschrift)'
	),
];

const INVOICE_WORDS = phrase('(?:invoice|bill|statement of account|rechnung|zahlungserinnerung)');

const PAYMENT_TERMS = [
	phrase('(?:amount|balance|total) (?:due|payable|outstanding)'),
	phrase('(?:due date|payment due|due by|pay by|payable by|payable within)'),
	phrase(
		'(?:fällig|fälligkeit|zahlbar (?:bis|innerhalb)|zahlungsziel|rechnungsbetrag|offener betrag)'
	),
];

/** IBAN candidates: country code, check digits, 11–30 more characters, optionally in blocks of four. */
const IBAN_CANDIDATE =
	/(?<![A-Z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?(?![A-Z0-9])/g;

/** The ISO 13616 mod-97 check of a compact IBAN. */
function isValidIban(compact: string): boolean {
	if (compact.length < 15 || compact.length > 34) return false;
	const rearranged = compact.slice(4) + compact.slice(0, 4);
	let remainder = 0;
	for (const char of rearranged) {
		const code = char.charCodeAt(0);
		const digits = code >= 65 ? String(code - 55) : char;
		for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}

function hasIban(text: string): boolean {
	for (const match of text.toUpperCase().matchAll(IBAN_CANDIDATE)) {
		if (isValidIban(match[0].replaceAll(' ', ''))) return true;
	}
	return false;
}

/** What the module doc lists, found in a message. Pure. */
export function detectExactWording(input: { subject?: string; text: string }): ExactWordingKind[] {
	const text = `${input.subject ?? ''}\n${input.text.slice(0, SCAN_CHARS)}`;
	const kinds: ExactWordingKind[] = [];
	const iban = hasIban(text);
	if (iban || PAYMENT_PHRASES.some((re) => re.test(text))) kinds.push('payment_details');
	if (LEGAL_PHRASES.some((re) => re.test(text))) kinds.push('legal_notice');
	if (INVOICE_WORDS.test(text) && (iban || PAYMENT_TERMS.some((re) => re.test(text)))) {
		kinds.push('invoice_payment');
	}
	return kinds;
}
