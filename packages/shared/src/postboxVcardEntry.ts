/**
 * The Postbox address-book entry a vCard becomes, and the bounds on it. Read by
 * the parser (`postboxVcardParse.ts`), the serializer (`postboxVcard.ts`) and
 * the server, which normalizes every entry again before writing it.
 */

import { normalizeEmail } from './address';
import { isValidEmail } from './utils/validation';

/** Largest .vcf file the contacts page reads. */
export const VCARD_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Cards read from one file; the rest of the file is not looked at. */
export const VCARD_MAX_CARDS = 5_000;
/** Address-book entries one import writes. */
export const VCARD_MAX_ENTRIES = 2_000;
/** Entries per import mutation call. */
export const VCARD_IMPORT_BATCH_SIZE = 100;
export const VCARD_MAX_EMAILS_PER_CARD = 10;
export const VCARD_MAX_PHONES = 10;
export const VCARD_MAX_ADDRESSES = 3;
const VCARD_MAX_EMAIL_LENGTH = 254;
/** A name or an organization. */
const VCARD_MAX_TEXT_LENGTH = 256;
/** One component of a postal address (street, city, …). */
const VCARD_MAX_ADDRESS_PART_LENGTH = 128;
const VCARD_MAX_PHONE_LENGTH = 64;

export const VCARD_PHONE_TYPES = ['cell', 'home', 'work', 'fax', 'pager'] as const;
export type VcardPhoneType = (typeof VCARD_PHONE_TYPES)[number];
export const VCARD_ADDRESS_TYPES = ['home', 'work'] as const;
export type VcardAddressType = (typeof VCARD_ADDRESS_TYPES)[number];

export interface VcardPhone {
	value: string;
	type?: VcardPhoneType;
}

export interface VcardPostalAddress {
	type?: VcardAddressType;
	poBox?: string;
	extended?: string;
	street?: string;
	locality?: string;
	region?: string;
	postalCode?: string;
	country?: string;
}

/** One address-book entry: the shape the import mutation takes and export reads. */
export interface VcardContactEntry {
	email: string;
	displayName?: string;
	organization?: string;
	phones?: VcardPhone[];
	postalAddresses?: VcardPostalAddress[];
}

/** The components of a postal address, in vCard `ADR` order. */
export const VCARD_ADDRESS_PARTS = [
	'poBox',
	'extended',
	'street',
	'locality',
	'region',
	'postalCode',
	'country',
] as const;

// Control characters become spaces; bidi overrides and isolates are dropped,
// so an imported name cannot reorder the text around it in the UI.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;
const BIDI_FORMAT_CHARS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g;

/** Trimmed, single-line, at most `max` UTF-16 units without a split surrogate pair. */
function clampText(raw: string | undefined, max: number): string | undefined {
	if (typeof raw !== 'string') return undefined;
	let text = raw.replace(BIDI_FORMAT_CHARS, '').replace(CONTROL_CHARS, ' ');
	text = text.replace(/\s+/g, ' ').trim();
	if (text.length > max) {
		const cut = /[\ud800-\udbff]/.test(text.charAt(max - 1)) ? max - 1 : max;
		text = text.slice(0, cut).trimEnd();
	}
	return text || undefined;
}

function phoneKey(value: string): string {
	return value.replace(/[^\d+]/g, '');
}

function normalizePhone(raw: VcardPhone): VcardPhone | null {
	const value = clampText(raw.value?.replace(/^tel:/i, ''), VCARD_MAX_PHONE_LENGTH);
	if (!value || !/\d/.test(value)) return null;
	const type = VCARD_PHONE_TYPES.find((known) => known === raw.type);
	return type ? { value, type } : { value };
}

function normalizeAddress(raw: VcardPostalAddress): VcardPostalAddress | null {
	const address: VcardPostalAddress = {};
	for (const part of VCARD_ADDRESS_PARTS) {
		const value = clampText(raw[part], VCARD_MAX_ADDRESS_PART_LENGTH);
		if (value) address[part] = value;
	}
	if (Object.keys(address).length === 0) return null;
	const type = VCARD_ADDRESS_TYPES.find((known) => known === raw.type);
	if (type) address.type = type;
	return address;
}

function addressKey(address: VcardPostalAddress): string {
	return VCARD_ADDRESS_PARTS.map((part) => (address[part] ?? '').toLowerCase()).join('\u0000');
}

/** Union of two phone lists by number, existing first, capped. */
export function mergeVcardPhones(
	existing: readonly VcardPhone[] | undefined,
	incoming: readonly VcardPhone[] | undefined
): VcardPhone[] {
	const merged: VcardPhone[] = [];
	const seen = new Set<string>();
	for (const phone of [...(existing ?? []), ...(incoming ?? [])]) {
		const normalized = normalizePhone(phone);
		if (!normalized) continue;
		const key = phoneKey(normalized.value);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(normalized);
		if (merged.length >= VCARD_MAX_PHONES) break;
	}
	return merged;
}

/** Union of two postal address lists, existing first, capped. */
export function mergeVcardAddresses(
	existing: readonly VcardPostalAddress[] | undefined,
	incoming: readonly VcardPostalAddress[] | undefined
): VcardPostalAddress[] {
	const merged: VcardPostalAddress[] = [];
	const seen = new Set<string>();
	for (const address of [...(existing ?? []), ...(incoming ?? [])]) {
		const normalized = normalizeAddress(address);
		if (!normalized) continue;
		const key = addressKey(normalized);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(normalized);
		if (merged.length >= VCARD_MAX_ADDRESSES) break;
	}
	return merged;
}

/**
 * The entry with every bound applied, or null when its address is not a
 * usable email address. Idempotent, so the server runs it again on what the
 * browser sent.
 */
export function normalizeVcardImportEntry(raw: VcardContactEntry): VcardContactEntry | null {
	if (typeof raw.email !== 'string') return null;
	const email = normalizeEmail(raw.email.trim().replace(/^mailto:/i, ''));
	if (email.length > VCARD_MAX_EMAIL_LENGTH || !isValidEmail(email)) return null;
	const entry: VcardContactEntry = { email };
	const displayName = clampText(raw.displayName, VCARD_MAX_TEXT_LENGTH);
	// An exported card without a name carries its address as FN (3.0 requires
	// one); reading it back must not turn the address into a name.
	if (displayName && displayName.toLowerCase() !== email) entry.displayName = displayName;
	const organization = clampText(raw.organization, VCARD_MAX_TEXT_LENGTH);
	if (organization) entry.organization = organization;
	const phones = mergeVcardPhones(undefined, raw.phones?.slice(0, VCARD_MAX_PHONES * 4));
	if (phones.length > 0) entry.phones = phones;
	const addresses = mergeVcardAddresses(
		undefined,
		raw.postalAddresses?.slice(0, VCARD_MAX_ADDRESSES * 4)
	);
	if (addresses.length > 0) entry.postalAddresses = addresses;
	return entry;
}
