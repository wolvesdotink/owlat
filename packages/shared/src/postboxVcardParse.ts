/**
 * vCard 3.0 (RFC 2426) and 4.0 (RFC 6350) parsing for the Postbox address
 * book, plus the quoted-printable lines phones still write in 2.1. Bounds and
 * normalization are in `postboxVcardEntry.ts`; see `postboxVcard.ts` for why
 * a file is read the way it is.
 */

import {
	VCARD_ADDRESS_PARTS,
	VCARD_ADDRESS_TYPES,
	normalizeVcardImportEntry,
	type VcardContactEntry,
	type VcardPhone,
	type VcardPhoneType,
	type VcardPostalAddress,
} from './postboxVcardEntry';
import {
	VCARD_MAX_ADDRESSES,
	VCARD_MAX_CARDS,
	VCARD_MAX_EMAILS_PER_CARD,
	VCARD_MAX_ENTRIES,
	VCARD_MAX_PHONES,
	VCARD_MAX_PHOTO_BYTES,
} from './postboxVcardLimits';

export interface VcardParseResult {
	entries: VcardContactEntry[];
	/** Cards read (at most {@link VCARD_MAX_CARDS}). */
	cardCount: number;
	/** Cards with no usable email address. */
	skippedWithoutEmail: number;
	/** The file held more cards or entries than one import takes. */
	isTruncated: boolean;
}

/**
 * Values kept per parameter name. A line may repeat a parameter without limit
 * (`TEL;HOME;HOME;…`); keeping a few makes each line's cost linear in its
 * length, and no real type list is longer.
 */
const MAX_PARAM_VALUES = 8;

/** The properties the parser assembles; every other line is skipped. */
const READ_PROPERTIES = new Set(['BEGIN', 'END', 'FN', 'N', 'ORG', 'EMAIL', 'TEL', 'ADR', 'PHOTO']);

/**
 * Characters of a PHOTO line assembled before the picture counts as too large
 * and the rest of the line is skipped: the base64 of the largest picture, plus
 * room for the property name, its parameters and a `data:` prefix.
 */
const MAX_PHOTO_LINE_CHARS = Math.ceil(VCARD_MAX_PHOTO_BYTES / 3) * 4 + 256;

const PHONE_TYPE_ALIASES: Record<string, VcardPhoneType> = {
	cell: 'cell',
	mobile: 'cell',
	iphone: 'cell',
	home: 'home',
	work: 'work',
	fax: 'fax',
	pager: 'pager',
};

interface ContentLine {
	name: string;
	params: Map<string, string[]>;
	value: string;
}

/** Split on `separator` outside double quotes. */
function splitOutsideQuotes(text: string, separator: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inQuotes = false;
	for (const char of text) {
		if (char === '"') inQuotes = !inQuotes;
		if (char === separator && !inQuotes) {
			parts.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts;
}

function colonOutsideQuotes(line: string): number {
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') inQuotes = !inQuotes;
		else if (char === ':' && !inQuotes) return i;
	}
	return -1;
}

function parseContentLine(line: string): ContentLine | null {
	const colon = colonOutsideQuotes(line);
	if (colon <= 0) return null;
	const [head = '', ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ';');
	const dot = head.lastIndexOf('.');
	const name = (dot >= 0 ? head.slice(dot + 1) : head).trim().toUpperCase();
	const params = new Map<string, string[]>();
	for (const raw of rawParams) {
		const eq = raw.indexOf('=');
		// vCard 2.1 writes bare parameters (`TEL;HOME;VOICE:`): those are types,
		// apart from the encoding and charset names it also writes bare.
		const bare = raw.trim().toUpperCase();
		const key =
			eq >= 0
				? raw.slice(0, eq).trim().toUpperCase()
				: bare === 'QUOTED-PRINTABLE' || bare === 'BASE64'
					? 'ENCODING'
					: 'TYPE';
		// Only TYPE, ENCODING and CHARSET are read, and none of their values holds
		// a comma, so a quoted list (`TYPE="voice,cell"`) splits like a bare one.
		const values = (eq >= 0 ? raw.slice(eq + 1) : raw)
			.split(',')
			.map((value) => value.replace(/"/g, '').trim().toLowerCase());
		const kept = params.get(key) ?? [];
		for (const value of values) {
			if (kept.length >= MAX_PARAM_VALUES) break;
			kept.push(value);
		}
		params.set(key, kept);
	}
	return { name, params, value: line.slice(colon + 1) };
}

function decodeQuotedPrintable(value: string, charset: string | undefined): string {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const hex = value.slice(i + 1, i + 3);
		if (value[i] === '=' && /^[0-9a-f]{2}$/i.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			i += 2;
		} else {
			bytes.push(value.charCodeAt(i) & 0xff);
		}
	}
	try {
		return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
	} catch {
		return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
	}
}

/** The value split on unescaped `;`, each component unescaped. */
function structuredValue(value: string): string[] {
	const components: string[] = [];
	let current = '';
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (char === '\\' && i + 1 < value.length) {
			const next = value[i + 1]!;
			current += next === 'n' || next === 'N' ? '\n' : next;
			i++;
		} else if (char === ';') {
			components.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	components.push(current);
	return components;
}

function textValue(value: string): string {
	return structuredValue(value).join(';');
}

interface CardBuilder {
	formattedName?: string;
	structuredName?: string[];
	organization?: string;
	emails: string[];
	phones: VcardPhone[];
	addresses: VcardPostalAddress[];
	/** The first inline PHOTO's base64, not yet checked. */
	photoBase64?: string;
}

/**
 * The base64 of an inline picture: `ENCODING=b` (3.0) or `BASE64` (2.1), or a
 * 4.0 `data:` URI. A picture named by any other URI is not fetched.
 */
function inlinePhoto(line: ContentLine, encoding: string | undefined): string | undefined {
	if (encoding === 'b' || encoding === 'base64') return line.value;
	const match = /^data:[^,]*;base64,/i.exec(line.value);
	return match ? line.value.slice(match[0].length) : undefined;
}

function newCard(): CardBuilder {
	return { emails: [], phones: [], addresses: [] };
}

function addProperty(card: CardBuilder, line: ContentLine): void {
	const encoding = line.params.get('ENCODING')?.[0];
	if (line.name === 'PHOTO') {
		card.photoBase64 ??= inlinePhoto(line, encoding);
		return;
	}
	if (encoding === 'b' || encoding === 'base64') return;
	const raw =
		encoding === 'quoted-printable'
			? decodeQuotedPrintable(line.value, line.params.get('CHARSET')?.[0])
			: line.value;
	const types = line.params.get('TYPE') ?? [];
	switch (line.name) {
		case 'FN':
			card.formattedName ??= textValue(raw);
			return;
		case 'N':
			card.structuredName ??= structuredValue(raw);
			return;
		case 'ORG':
			card.organization ??= structuredValue(raw)
				.map((part) => part.trim())
				.filter(Boolean)
				.join(', ');
			return;
		case 'EMAIL':
			if (card.emails.length < VCARD_MAX_EMAILS_PER_CARD) card.emails.push(textValue(raw));
			return;
		case 'TEL': {
			if (card.phones.length >= VCARD_MAX_PHONES) return;
			const type = types.map((t) => PHONE_TYPE_ALIASES[t]).find(Boolean);
			card.phones.push(type ? { value: textValue(raw), type } : { value: textValue(raw) });
			return;
		}
		case 'ADR': {
			if (card.addresses.length >= VCARD_MAX_ADDRESSES) return;
			const parts = structuredValue(raw);
			const address: VcardPostalAddress = {};
			for (const [index, part] of VCARD_ADDRESS_PARTS.entries()) {
				if (parts[index]) address[part] = parts[index];
			}
			const type = VCARD_ADDRESS_TYPES.find((known) => types.includes(known));
			if (type) address.type = type;
			card.addresses.push(address);
			return;
		}
	}
}

/** FN, or the name N spells out (prefix, given, additional, family, suffix). */
function cardDisplayName(card: CardBuilder): string | undefined {
	if (card.formattedName?.trim()) return card.formattedName;
	const [family, given, additional, prefix, suffix] = card.structuredName ?? [];
	const name = [prefix, given, additional, family, suffix]
		.map((part) => part?.trim())
		.filter(Boolean)
		.join(' ');
	return name || undefined;
}

function cardEntries(card: CardBuilder): VcardContactEntry[] {
	const entries: VcardContactEntry[] = [];
	const seen = new Set<string>();
	for (const email of card.emails) {
		// The picture goes to the first address only, which stores it once.
		const photo =
			entries.length === 0 && card.photoBase64 !== undefined
				? { mediaType: 'image/jpeg' as const, base64: card.photoBase64 }
				: undefined;
		const entry = normalizeVcardImportEntry({
			email,
			displayName: cardDisplayName(card),
			organization: card.organization,
			phones: card.phones,
			postalAddresses: card.addresses,
			photo,
		});
		if (!entry || seen.has(entry.email)) continue;
		seen.add(entry.email);
		entries.push(entry);
	}
	return entries;
}

/**
 * The address-book entries of a .vcf file's text. Lines outside a card, nested
 * cards (2.1 `AGENT`) and unknown properties are ignored.
 */
export function parseVcards(text: string): VcardParseResult {
	const entries: VcardContactEntry[] = [];
	let cardCount = 0;
	let skippedWithoutEmail = 0;
	let isTruncated = false;
	// One import's worth of cards or entries has been read.
	let isFull = false;
	let card: CardBuilder | null = null;
	let depth = 0;

	const finishLine = (logical: string) => {
		const upper = logical.slice(0, 12).toUpperCase();
		if (upper.startsWith('BEGIN:VCARD')) {
			depth++;
			if (depth === 1) card = newCard();
			return;
		}
		if (upper.startsWith('END:VCARD')) {
			if (depth === 1 && card) {
				cardCount++;
				const fromCard = cardEntries(card);
				if (fromCard.length === 0) skippedWithoutEmail++;
				for (const entry of fromCard) {
					if (entries.length >= VCARD_MAX_ENTRIES) {
						isTruncated = true;
						break;
					}
					entries.push(entry);
				}
				card = null;
				isFull = cardCount >= VCARD_MAX_CARDS || entries.length >= VCARD_MAX_ENTRIES;
			}
			depth = Math.max(0, depth - 1);
			return;
		}
		if (depth !== 1 || !card) return;
		const line = parseContentLine(logical);
		if (line) addProperty(card, line);
	};

	// The pieces of the logical line being unfolded; null while a skipped
	// property's continuation lines stream past.
	let pieces: string[] | null = null;
	let isInLine = false;
	let isQuotedPrintable = false;
	let isSoftBroken = false;
	// Characters a PHOTO line may still add before it is dropped.
	let photoBudget = Infinity;
	const flush = () => {
		if (pieces !== null) finishLine(pieces.join(''));
		pieces = null;
	};
	for (const raw of text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/)) {
		const isContinuation = isInLine && (raw.startsWith(' ') || raw.startsWith('\t'));
		if (isContinuation || isSoftBroken) {
			const piece = isContinuation ? raw.slice(1) : raw;
			isSoftBroken = isQuotedPrintable && piece.endsWith('=');
			photoBudget -= piece.length;
			if (photoBudget < 0) pieces = null;
			pieces?.push(isSoftBroken ? piece.slice(0, -1) : piece);
			continue;
		}
		flush();
		isInLine = false;
		if (isFull) {
			if (raw.trim()) {
				isTruncated = true;
				break;
			}
			continue;
		}
		isInLine = raw.length > 0;
		const colon = colonOutsideQuotes(raw);
		// vCard 2.1: a quoted-printable value that ends in `=` continues on the
		// next line, which is not indented.
		isQuotedPrintable = colon > 0 && /quoted-printable/i.test(raw.slice(0, colon));
		isSoftBroken = isQuotedPrintable && raw.endsWith('=');
		const property = propertyName(raw);
		if (!READ_PROPERTIES.has(property)) continue;
		photoBudget = property === 'PHOTO' ? MAX_PHOTO_LINE_CHARS - raw.length : Infinity;
		if (photoBudget < 0) continue;
		pieces = [isSoftBroken ? raw.slice(0, -1) : raw];
	}
	flush();

	return { entries, cardCount, skippedWithoutEmail, isTruncated };
}

/** The upper-cased property name of a raw line, without its group. */
function propertyName(raw: string): string {
	const end = raw.search(/[;:]/);
	const head = end >= 0 ? raw.slice(0, end) : raw;
	const dot = head.lastIndexOf('.');
	return (dot >= 0 ? head.slice(dot + 1) : head).trim().toUpperCase();
}
