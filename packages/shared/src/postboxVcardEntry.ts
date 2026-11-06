/**
 * The Postbox address-book entry a vCard becomes, and the bounds on it. Read by
 * the parser (`postboxVcardParse.ts`), the serializer (`postboxVcard.ts`) and
 * the server, which normalizes every entry again before writing it.
 */

import { normalizeEmail } from './address';
import { VCARD_MAX_ADDRESSES, VCARD_MAX_PHONES, VCARD_MAX_PHOTO_BYTES } from './postboxVcardLimits';
import { isValidEmail } from './utils/validation';

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

/** The raster formats a contact picture may be in; anything else is dropped. */
const VCARD_PHOTO_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type VcardPhotoMediaType = (typeof VCARD_PHOTO_MEDIA_TYPES)[number];

/** A card's inline picture: its type, read from the bytes, and the bytes in base64. */
export interface VcardPhoto {
	mediaType: VcardPhotoMediaType;
	base64: string;
}

/** One address-book entry: the shape the import mutation takes and export reads. */
export interface VcardContactEntry {
	email: string;
	displayName?: string;
	organization?: string;
	phones?: VcardPhone[];
	postalAddresses?: VcardPostalAddress[];
	/**
	 * The card's picture. Only the card's first address carries it, so one
	 * picture becomes one stored image, and the import mutation never takes it
	 * (`contactsPhotos.ts` does).
	 */
	photo?: VcardPhoto;
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

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded size of a base64 string without padding errors. */
function base64DecodedLength(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return (base64.length / 4) * 3 - padding;
}

/** The leading bytes of a base64 string, decoded. */
function base64Prefix(base64: string, bytes: number): number[] {
	const chunk = base64.slice(0, Math.ceil(bytes / 3) * 4);
	const binary = atob(chunk);
	return Array.from(binary.slice(0, bytes), (char) => char.charCodeAt(0));
}

/** The raster type the bytes start with, or null (SVG and the rest are not pictures here). */
function sniffPhotoType(prefix: readonly number[]): VcardPhotoMediaType | null {
	const startsWith = (...magic: number[]) => magic.every((byte, i) => prefix[i] === byte);
	if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
	if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
	if (startsWith(0x52, 0x49, 0x46, 0x46) && prefix.slice(8, 12).join() === '87,69,66,80') {
		return 'image/webp';
	}
	return null;
}

/**
 * A picture from base64 text, or null when it is not valid base64, is larger
 * than {@link VCARD_MAX_PHOTO_BYTES} decoded, or is not a raster image. The type
 * comes from the bytes, never from what the card claims.
 */
export function normalizeVcardPhoto(base64: string | undefined): VcardPhoto | null {
	if (typeof base64 !== 'string') return null;
	const text = base64.replace(/\s+/g, '');
	if (text.length === 0 || text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return null;
	if (base64DecodedLength(text) > VCARD_MAX_PHOTO_BYTES) return null;
	let prefix: number[];
	try {
		prefix = base64Prefix(text, 12);
	} catch {
		return null;
	}
	const mediaType = sniffPhotoType(prefix);
	return mediaType ? { mediaType, base64: text } : null;
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
	const photo = raw.photo ? normalizeVcardPhoto(raw.photo.base64) : null;
	if (photo) entry.photo = photo;
	return entry;
}
