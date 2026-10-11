/**
 * Line-level markers for `segmentMessage` (`./mailSegments`): quote
 * attributions, forward banners, Outlook header blocks, signature delimiters
 * and closings, and legal/confidentiality disclaimers, in English, German and
 * French. Every test here reads ONE line (or one paragraph) that the caller has
 * already split out and stripped of `>` markers.
 *
 * Every pattern is anchored or length-bounded, so a hostile line cannot make a
 * match quadratic.
 */

import { QUOTE_ATTRIBUTION_PATTERNS } from './quotedText';

/** A participant named by a quote attribution or a forwarded header. */
export interface SegmentAuthor {
	name?: string;
	email?: string;
}

/** What an attribution or header block says about the quoted message. */
export interface QuoteOrigin {
	author?: SegmentAuthor;
	/** The date as written (unparsed: client formats and locales vary too much). */
	sentAt?: string;
}

// ── Attribution lines ("On … wrote:") ──

/**
 * Whole-line attributions. `QUOTE_ATTRIBUTION_PATTERNS` (shared with the
 * composer's quote split) covers the common English, German and French
 * spellings; these add the Gmail and Apple Mail variants it misses (weekday
 * abbreviations in German and French, ISO dates) while requiring the line to
 * END with the "wrote:" verb, so prose that merely mentions writing never
 * opens a quote.
 */
const ATTRIBUTION_LINE = [
	/^On\s.{4,300}?\bwrote\s*:$/i,
	/^Am\s.{4,300}?\bschrieb\b.{0,300}:$/,
	/^Le\s.{4,300}?\ba\s+écrit\s*:$/i,
];

/** The tail of an attribution that wrapped onto a second line. */
const ATTRIBUTION_TAIL = /(?:\bwrote|\bschrieb\b.{0,300}|\ba\s+écrit)\s*:$/i;
const ATTRIBUTION_HEAD = /^(?:On|Am|Le)\s/;

/** Whether `line` (trimmed) is a whole quote attribution. */
export function isAttributionLine(line: string): boolean {
	const text = line.trim();
	if (text.length > 400) return false;
	if (ATTRIBUTION_LINE.some((pattern) => pattern.test(text))) return true;
	// The shared patterns count only when they start the line, and the line
	// still has to end on the verb's colon.
	if (!text.endsWith(':')) return false;
	return QUOTE_ATTRIBUTION_PATTERNS.some((pattern) => pattern.exec(text)?.index === 0);
}

/** Whether `head` + `tail` are one attribution wrapped over two lines. */
export function isWrappedAttribution(head: string, tail: string): boolean {
	const first = head.trim();
	const second = tail.trim();
	if (!ATTRIBUTION_HEAD.test(first) || second.length > 200) return false;
	return ATTRIBUTION_TAIL.test(second) && isAttributionLine(`${first} ${second}`);
}

/**
 * Whether `line` carries an attribution somewhere other than at its start (an
 * HTML body without block tags runs it into the text before). The caller does
 * not split there: it reports the message as uncertain instead.
 */
export function hasEmbeddedAttribution(line: string): boolean {
	const text = line.trim();
	if (text.length > 4000) return false;
	return QUOTE_ATTRIBUTION_PATTERNS.some((pattern) => {
		const match = text.match(pattern);
		return match?.index !== undefined && match.index > 0;
	});
}

const TIME_OR_YEAR =
	/(?:\d{1,2}[:.h]\s?\d{2}(?:\s?[AaPp]\.?\s?[Mm]\.?)?(?:\s?Uhr)?|\b\d{4}\b)(?:\s*\([^)]{0,40}\))?/g;

/** Who wrote the quoted message and when, read off an attribution line. */
export function parseAttribution(line: string): QuoteOrigin {
	const text = line.trim().replace(/\s+/g, ' ');
	const german = /^Am\s(.+?)\sschrieb\s(.+?):$/.exec(text);
	if (german) {
		return { sentAt: german[1]?.trim(), author: parseAddress(german[2] ?? '') };
	}
	const body = text
		.replace(/^(?:On|Le)\s/i, '')
		.replace(/\s(?:wrote|a\s+écrit)\s*:$/i, '')
		.trim();
	// The author follows the last time or year token ("… 10:00 AM Jonas <…>",
	// "… 2026, at 10:00, Jonas …") or, failing that, the last comma.
	let cut = -1;
	for (const match of body.matchAll(TIME_OR_YEAR)) cut = match.index + match[0].length;
	if (cut < 0) cut = body.lastIndexOf(',');
	if (cut < 0) return {};
	const sentAt = body
		.slice(0, cut)
		.replace(/[,\s]+$/, '')
		.trim();
	const rest = body
		.slice(cut)
		.replace(/^[,\s]*(?:at\s|à\s)?/, '')
		.replace(/^[,\s]+/, '')
		.trim();
	const author = parseAddress(rest);
	return { ...(sentAt ? { sentAt } : {}), ...(author ? { author } : {}) };
}

// ── Addresses ──

const ANGLE_EMAIL = /<\s*(?:mailto:)?([^<>\s@]{1,128}@[^<>\s@]{1,253})\s*>/i;
const BRACKET_EMAIL = /\[\s*mailto:([^[\]\s@]{1,128}@[^[\]\s@]{1,253})\s*\]/i;
const BARE_EMAIL = /^[^\s@<>()[\]",;]{1,128}@[^\s@<>()[\]",;]{1,253}$/;

/** `Jonas Weber <jonas@example.com>` (or a bare address, or a bare name). */
export function parseAddress(value: string): SegmentAuthor | undefined {
	const text = value.trim().replace(/\s+/g, ' ');
	if (!text || text.length > 400) return undefined;
	const marked = ANGLE_EMAIL.exec(text) ?? BRACKET_EMAIL.exec(text);
	if (marked) {
		const name = text
			.slice(0, marked.index)
			.trim()
			.replace(/^["']|["']$/g, '')
			.trim();
		return { ...(name ? { name } : {}), email: (marked[1] ?? '').toLowerCase() };
	}
	if (BARE_EMAIL.test(text)) return { email: text.toLowerCase() };
	const name = text.replace(/^["']|["']$/g, '').trim();
	// A long run of words is a sentence, not a name.
	if (!name || name.split(' ').length > 6) return undefined;
	return { name };
}

// ── Forward banners and header blocks ──

const FORWARD_BANNER = [
	/^-{2,}\s*(?:Forwarded message|Forwarded Message|Weitergeleitete Nachricht|Message transféré|Message transfere|Mensaje reenviado)\s*-{2,}$/i,
	/^(?:Begin forwarded message|Anfang der weitergeleiteten Nachricht|Début du message (?:réexpédié|transféré))\s*:$/i,
];

/** Whether `line` opens a forwarded message (Gmail, Apple Mail, Thunderbird). */
export function isForwardBanner(line: string): boolean {
	const text = line.trim();
	return text.length <= 120 && FORWARD_BANNER.some((pattern) => pattern.test(text));
}

const ORIGINAL_MESSAGE =
	/^-{2,}\s*(?:Original Message|Original-Nachricht|Ursprüngliche Nachricht|Message d'origine|Message d’origine)\s*-{2,}$/i;

/** Outlook's / Thunderbird's `-----Original Message-----` line, in EN/DE/FR. */
export function isOriginalMessageLine(line: string): boolean {
	const text = line.trim();
	return text.length <= 120 && ORIGINAL_MESSAGE.test(text);
}

/** Outlook's `________________________________` separator. */
export function isSeparatorLine(line: string): boolean {
	return /^_{4,}$/.test(line.trim());
}

export type HeaderField = 'from' | 'date' | 'to' | 'cc' | 'subject' | 'replyTo';

const HEADER_LABELS = new Map<string, HeaderField>([
	['from', 'from'],
	['von', 'from'],
	['de', 'from'],
	['sent', 'date'],
	['date', 'date'],
	['gesendet', 'date'],
	['datum', 'date'],
	['envoyé', 'date'],
	['to', 'to'],
	['an', 'to'],
	['à', 'to'],
	['pour', 'to'],
	['cc', 'cc'],
	['subject', 'subject'],
	['betreff', 'subject'],
	['objet', 'subject'],
	['reply-to', 'replyTo'],
	['antwort an', 'replyTo'],
	['répondre à', 'replyTo'],
]);

const HEADER_LINE = /^\*{0,2}([A-Za-zÀ-ÿ-]{1,12}(?: [a-zà]{1,3})?)\s?:\*{0,2}\s*(.{0,500})$/;

/** One `Label: value` line of an Outlook or forwarded header block. */
export function parseHeaderLine(line: string): { field: HeaderField; value: string } | null {
	const match = HEADER_LINE.exec(line.trim());
	if (!match) return null;
	const field = HEADER_LABELS.get((match[1] ?? '').toLowerCase());
	return field ? { field, value: (match[2] ?? '').trim() } : null;
}

/**
 * A forwarded subject: `FW:`, `Fwd:`, German `WG:`, French `TR:`. A reply to a
 * forward (`RE: FW: …`) is a reply.
 */
export function isForwardSubject(subject: string): boolean {
	return /^(?:FW|FWD|WG|TR)\s?:/i.test(subject.trim());
}

/** A reply subject: `RE:`, German `AW:`/`Antw:`, French `Réf:`, Nordic `SV:`. */
function isReplySubject(subject: string): boolean {
	return /^(?:RE|AW|ANTW|RÉF|REF|SV)\s?:/i.test(subject.trim());
}

/** What a message's own subject says it is (see `ClassifyOptions.subjectKind`). */
export function subjectKindOf(
	subject: string | null | undefined
): 'forward' | 'reply' | 'other' | undefined {
	if (!subject) return undefined;
	if (isForwardSubject(subject)) return 'forward';
	return isReplySubject(subject) ? 'reply' : 'other';
}

// ── Signatures ──

/** The RFC 3676 `-- ` delimiter (clients often drop its trailing space). */
export function isSignatureDelimiter(line: string): boolean {
	return line === '-- ' || line === '--' || line.trimEnd() === '--';
}

const MOBILE_SIGNATURE =
	/^(?:Sent from (?:my |Mail for |Outlook for |Yahoo Mail for )|Get Outlook for |Von meinem .{2,40} gesendet|Gesendet von meinem |Von Outlook für .{2,20} gesendet|Envoyé de mon |Envoyé à partir de |Télécharger Outlook pour )/i;

/** "Sent from my iPhone" and its German and French spellings. */
export function isMobileSignature(line: string): boolean {
	const text = line.trim();
	return text.length <= 80 && MOBILE_SIGNATURE.test(text);
}

const CLOSING =
	/^(?:(?:best|kind|warm|many|with best)\s+(?:regards|wishes)|regards|best|cheers|thanks(?: again| a lot| so much)?|thank you|many thanks|sincerely|yours(?: sincerely| truly)?|all the best|talk soon|(?:mit\s+)?(?:(?:sehr\s+)?freundlichen?|besten?|herzlichen?|lieben?|vielen?|schönen?)\s+grü(?:ß|ss)en?|(?:mit\s+)?(?:freundlichem|bestem|herzlichem)\s+gru(?:ß|ss)|grü(?:ß|ss)e|gru(?:ß|ss)|lg|vg|mfg|danke(?: dir| ihnen| schön)?|vielen dank|bis bald|cordialement|bien cordialement|bien à (?:vous|toi)|bonne (?:journée|soirée)|merci(?: beaucoup| d'avance)?|à bientôt|amicalement|salutations(?: distinguées)?)[\s,.!]*$/i;

/** A closing on a line of its own ("Best regards,", "Viele Grüße", "Cordialement"). */
export function isClosingLine(line: string): boolean {
	const text = line.trim();
	return text.length <= 40 && CLOSING.test(text);
}

/** `P.S.`, `PS:`, `P.P.S.`, `PPS` opening a line: a postscript is message text. */
const POSTSCRIPT = /^(?:P\.?\s?){1,3}S\b\.?/i;

export function isPostscriptLine(line: string): boolean {
	return POSTSCRIPT.test(line.trim());
}

/** Words that make a line a request or an instruction, never a name block. */
const REQUEST =
	/\b(?:please|pls|kindly|could you|can you|would you|will you|let me know|make sure|don't forget|bitte|kannst du|könntest du|können sie|könnten sie|würdest du|denk daran|merci de|pourriez|pouvez|peux-tu|veuillez|n'oublie)\b/i;

/**
 * A line that opens with an imperative ("Call Jonas.", "Pay Acme.", "Ruf mich
 * an.", "Appelle-moi.") is an instruction, never a name, whatever its case.
 */
const IMPERATIVE_START =
	/^(?:please|call|phone|ring|pay|send|sign|book|confirm|reply|review|check|approve|forward|schedule|transfer|wire|email|contact|order|buy|cancel|update|share|submit|return|bring|ask|tell|remind|bitte|ruf|rufe|zahl|zahle|überweis|überweise|schick|schicke|sende|unterschreib|unterschreibe|buch|buche|bestätig|bestätige|prüf|prüfe|antworte|melde|kontaktiere|appelle|appelez|paie|payez|envoie|envoyez|signe|signez|réserve|réservez|confirme|confirmez|rappelle|rappelez|vérifie|vérifiez)\b/i;
/** A company-form or title abbreviation, the one way a name-block part may end in a period. */
const ABBREVIATION_END = /\b(?:Ltd|Inc|Co|Corp|Bros|Jr|Sr|Dr|Prof|e\.\s?V|S\.A|S\.à\s?r\.l)\.$/i;

/** A personal name: one to five capitalised words, with the usual particles. */
const PERSON_NAME =
	/^\p{Lu}[\p{L}'’.-]*(?:\s+(?:\p{Lu}[\p{L}'’.-]*|von|van|der|den|de|da|di|du|le|la|y|zu))*$/u;
/** A word of a title-cased company or role line. */
const TITLE_WORD =
	/^(?:[\p{Lu}\d][\p{L}\d&'’.()+-]*|&|of|for|and|at|de|der|des|du|für|und|la|le|et|y|von|van|zu)$/u;
/** A company form or a role, as a whole word of a title-cased line. */
const COMPANY_OR_ROLE =
	/\b(?:GmbH|AG|KG|UG|e\.\s?V\.|Ltd|LLC|LLP|Inc|Corp|Co\.|SAS|SARL|SA|BV|NV|Oy|AB|Studio|Agency|Agentur|Group|Gruppe|Team|CEO|CTO|COO|CFO|Founder|Co-?founder|Owner|Inhaber\w*|Manager\w*|Director|Head|Lead|Engineer|Designer|Developer|Consultant|Berater\w*|Partner\w*|Geschäftsführ\w*|Leiter\w*|Directeur|Directrice|Responsable|Gérant\w*|Assistant\w*|Assistenz|Sales|Vertrieb|Marketing|Support|Office|Büro)\b/i;
const EMAIL = /^(?:mailto:)?[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+$/i;
const URL_SHAPE = /^(?:https?:\/\/|www\.)\S+$/i;
const PHONE = /^\+?[\d\s()./-]{6,24}\d$/;
const CONTACT_LABEL =
	/^(?:tel|phone|mobile|mob|cell|fax|telefon|handy|tél|portable|e-?mail|mail|web|website|contact|m|t|f|p|w|e)\.?\s*:?\s+/i;
/** A postal address part: street and number, postcode and town. */
const ADDRESS = [
	/^[\p{L}.\s-]*(?:straße|strasse|str\.|weg|platz|allee|gasse|ring|damm)\s*\d+\s?\p{L}?$/iu,
	/^(?:[A-Z]{1,2}-)?\d{4,5}\s+\p{Lu}[\p{L}\s.-]*$/u,
	/^\d+[a-z]?\s+(?:\p{Lu}[\p{L}.]*\s+){1,4}(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Lane|Ln\.?|Way|Boulevard|Blvd\.?|Drive|Dr\.?)$/u,
	/^\d+,?\s+(?:rue|avenue|boulevard|place|chemin|allée)\s+[\p{L}\s'’-]+$/iu,
];
/** A company legal part that starts with its label ("Amtsgericht Berlin HRB 12345"). */
const LEGAL_PART =
	/^(?:Geschäftsführer(?:in)?|Geschäftsführung|Vorstand|Sitz(?: der Gesellschaft)?|Registergericht|Amtsgericht|Handelsregister|HRB|HRA|USt-?IdNr\.?|Steuer-?Nr\.?|VAT(?: No\.?| number| ID)?|Registered (?:office|in England(?: and Wales)?)|Company (?:number|registration(?: number)?|No\.?)|SIRET|SIREN|RCS|Capital social)\b[\s:.]*[\p{L}\d\s.,&/()'’-]*$/iu;

/** One `|`/`·`/`,`-separated part of a name-block line: it must BE one of the shapes. */
function isNamePart(part: string): boolean {
	// An instruction or a sentence is never part of a name block.
	if (IMPERATIVE_START.test(part) && !CONTACT_LABEL.test(part)) return false;
	if (/[.!]$/.test(part) && !ABBREVIATION_END.test(part)) return false;
	const value = part.replace(CONTACT_LABEL, '');
	if (EMAIL.test(value) || URL_SHAPE.test(value)) return true;
	if (PHONE.test(value) && (value.match(/\d/g) ?? []).length >= 6) return true;
	if (ADDRESS.some((shape) => shape.test(part)) || LEGAL_PART.test(part)) return true;
	const words = part.split(/\s+/);
	if (words.length > 8 || !words.every((word) => TITLE_WORD.test(word))) return false;
	return (words.length <= 5 && PERSON_NAME.test(part)) || COMPANY_OR_ROLE.test(part);
}

/**
 * A line that fits in a name block under a closing: every part of it (split on
 * `|`, `·`, `,`) IS a name, a title-cased company or role, an email address, a
 * link, a phone number, an address or a company legal entry. A sentence that
 * merely contains one ("Reply to billing@example.com.", "Send the invoice to
 * Support.") is not; neither is a postscript, a question or a request.
 */
export function isNameBlockLine(line: string): boolean {
	const text = line.trim();
	if (!text || text.length > 240) return false;
	if (text.endsWith('?') || isPostscriptLine(text) || REQUEST.test(text)) return false;
	return text
		.split(/\s*[|·•,;]\s*|\s{2,}/)
		.filter((part) => part !== '')
		.every(isNamePart);
}

// ── Disclaimers ──

const DISCLAIMER = [
	/\bconfidential\b[\s\S]{0,300}\b(?:intended|recipient|addressee|privileged)\b/i,
	/\b(?:intended|addressee)\b[\s\S]{0,200}\bconfidential\b/i,
	/\bif you (?:are not|have received this)[\s\S]{0,120}\b(?:intended recipient|in error)\b/i,
	/\bthis (?:e-?mail|message|communication)[\s\S]{0,80}\b(?:is|are|may (?:be|contain)|contains?)\b[\s\S]{0,80}\b(?:confidential|privileged)\b/i,
	/^\s*disclaimer\s*:/i,
	/\bplease consider the environment before printing\b/i,
	/\bvertraulich[\s\S]{0,300}\b(?:empfänger|adressat|irrtümlich|irrtum)/i,
	/\b(?:wenn|falls) sie nicht der (?:richtige|beabsichtigte|vorgesehene) (?:adressat|empfänger)/i,
	/\bdiese (?:e-?mail|nachricht)[\s\S]{0,120}\bvertraulich/i,
	/\b(?:ce|le présent) (?:message|courriel|e-?mail)[\s\S]{0,160}\b(?:confidentiel|strictement réservé)/i,
	/\bsi vous (?:n'êtes pas|n’êtes pas|avez reçu ce (?:message|courriel) par erreur)/i,
];

const LEGAL_FOOTER =
	/\b(?:Geschäftsführer(?:in)?|Geschäftsführung|Sitz der Gesellschaft|Registergericht|Amtsgericht|Handelsregister|HRB\s?\d+|USt-?IdNr|Registered (?:office|in England)|Company (?:number|registration)|SIRET|RCS\s)\b/;

/** Whether a paragraph is a confidentiality notice (EN / DE / FR). */
export function isConfidentialityNotice(paragraph: string): boolean {
	const text = paragraph.length > 4000 ? paragraph.slice(0, 4000) : paragraph;
	return DISCLAIMER.some((pattern) => pattern.test(text));
}

/**
 * Whether a line is a company legal footer (register court, managing
 * directors, VAT id). Only read inside a signature: in running text the same
 * words can be part of a request.
 */
export function isLegalFooterLine(line: string): boolean {
	return line.length <= 400 && LEGAL_FOOTER.test(line);
}
