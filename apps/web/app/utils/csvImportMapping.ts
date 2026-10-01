/**
 * Pure mapping and row-preparation rules for the CSV contact import.
 *
 * The import used to read the mapping three ways: validation and the preview
 * took the FIRST column mapped to Email, serialization let the LAST nonempty one
 * win. With `email` and `secondary_email` both auto-mapped, the preview showed
 * one address and the import wrote the other. Two rules close that:
 *
 * - A scalar destination (Email, First name, Last name, Language) has exactly
 *   one owning column. Auto-detection hands out each one once, and assigning a
 *   taken field to another column moves it there.
 * - `prepareCsvRows` builds every row once, and validation, the preview and the
 *   import payload all read those rows.
 */

export type MappableField =
	| 'email'
	| 'firstName'
	| 'lastName'
	| 'language'
	| 'topic'
	| 'property'
	| 'ignore';

export type ContactPropertyValue = string | number | boolean | null;

export interface ContactImport {
	email: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	properties?: Record<string, ContactPropertyValue>;
}

/** Column index → destination field. */
export type ColumnMapping = Record<number, MappableField>;

/** Destinations a contact holds one value of, so only one column may feed each. */
export const SCALAR_FIELDS = ['email', 'firstName', 'lastName', 'language'] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

export const isScalarField = (field: MappableField): field is ScalarField =>
	(SCALAR_FIELDS as readonly string[]).includes(field);

const HEADER_ALIASES: Record<'firstName' | 'lastName' | 'language' | 'topic', string[]> = {
	firstName: ['first name', 'firstname', 'first_name', 'given name'],
	lastName: ['last name', 'lastname', 'last_name', 'family name', 'surname'],
	language: ['language', 'lang', 'locale', 'preferred_language'],
	topic: ['list', 'topic', 'topics', 'mailing list', 'mailing_list', 'mailinglist', 'lists'],
};

const normalizeHeader = (header: string) => header.toLowerCase().trim();
const isEmailLike = (header: string) => header.includes('email') || header.includes('e-mail');

/**
 * Where a column goes when it loses (or never gets) a scalar field it looked
 * like: a custom property keyed by its header, so its data still reaches the
 * contact. A blank header cannot be a property key (the import would drop the
 * values unannounced), so that column is skipped instead.
 */
const fallbackFieldFor = (header: string | undefined): MappableField =>
	header?.trim() ? 'property' : 'ignore';

/**
 * Initial mapping from the header names. Email goes to one column only: an
 * exact `email` header, else `e-mail`, else the first header containing
 * "email". Every other email-like header (`secondary_email`, `billing_email`)
 * becomes a custom property. First name, Last name and Language likewise go to
 * the first matching header; a repeat becomes a custom property.
 */
export function detectColumnMapping(headers: readonly string[]): ColumnMapping {
	const normalized = headers.map(normalizeHeader);
	const emailColumn = [
		normalized.indexOf('email'),
		normalized.indexOf('e-mail'),
		normalized.findIndex((header) => header.includes('email')),
	].find((index) => index >= 0);

	const mapping: ColumnMapping = {};
	const owned = new Set<ScalarField>();
	for (const [index, header] of normalized.entries()) {
		if (index === emailColumn) {
			mapping[index] = 'email';
			continue;
		}
		if (isEmailLike(header)) {
			mapping[index] = fallbackFieldFor(headers[index]);
			continue;
		}
		const suggested = (Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]).find(
			(field) => HEADER_ALIASES[field].includes(header)
		);
		if (suggested === undefined) {
			mapping[index] = 'ignore';
		} else if (isScalarField(suggested) && owned.has(suggested)) {
			mapping[index] = fallbackFieldFor(headers[index]);
		} else {
			if (isScalarField(suggested)) owned.add(suggested);
			mapping[index] = suggested;
		}
	}
	return mapping;
}

/**
 * The mapping after `column` is set to `field`. A scalar field already owned by
 * another column moves: that column falls back to `fallbackFieldFor` its header.
 * Returns the columns that were displaced, so the caller can announce them.
 */
export function assignColumnField(
	mapping: ColumnMapping,
	headers: readonly string[],
	column: number,
	field: MappableField
): { mapping: ColumnMapping; displaced: number[] } {
	const next: ColumnMapping = { ...mapping, [column]: field };
	const displaced: number[] = [];
	if (isScalarField(field)) {
		for (const [indexStr, mapped] of Object.entries(mapping)) {
			const index = Number(indexStr);
			if (index === column || mapped !== field) continue;
			next[index] = fallbackFieldFor(headers[index]);
			displaced.push(index);
		}
	}
	return { mapping: next, displaced };
}

/**
 * The column that feeds each scalar field. Should two columns ever claim one
 * (a mapping set programmatically), the lowest index wins everywhere, so the
 * preview and the import still agree; `conflictingScalarField` reports it.
 */
export function scalarFieldOwners(mapping: ColumnMapping): Partial<Record<ScalarField, number>> {
	const owners: Partial<Record<ScalarField, number>> = {};
	for (const [indexStr, field] of Object.entries(mapping)) {
		const index = Number(indexStr);
		if (!isScalarField(field)) continue;
		const current = owners[field];
		if (current === undefined || index < current) owners[field] = index;
	}
	return owners;
}

/** The first scalar field mapped from more than one column, if any. */
export function conflictingScalarField(mapping: ColumnMapping): ScalarField | null {
	const counts = new Map<ScalarField, number>();
	for (const field of Object.values(mapping)) {
		if (isScalarField(field)) counts.set(field, (counts.get(field) ?? 0) + 1);
	}
	return SCALAR_FIELDS.find((field) => (counts.get(field) ?? 0) > 1) ?? null;
}

export type PreparedRowStatus = 'valid' | 'invalid' | 'duplicate' | 'missing';

/** One CSV data row exactly as the import will send it. */
export interface PreparedRow {
	/** 1-based data-row number, the numbering the preview's warnings use. */
	row: number;
	/** `email` is `''` for a row without one; such rows are never sent. */
	contact: ContactImport;
	status: PreparedRowStatus;
}

// Basic email validation: an @ with something before it and a . after it.
const looksLikeEmail = (email: string) => {
	const atIndex = email.indexOf('@');
	const dotIndex = email.indexOf('.', atIndex);
	return atIndex > 0 && dotIndex > atIndex + 1 && dotIndex < email.length - 1;
};

/**
 * Build every data row once, from the one owning column per scalar field and
 * every column mapped to a custom property (keyed by its trimmed header).
 * Duplicates are judged case-insensitively against earlier valid rows.
 */
export function prepareCsvRows(
	rows: readonly string[][],
	headers: readonly string[],
	mapping: ColumnMapping
): PreparedRow[] {
	const owners = scalarFieldOwners(mapping);
	const propertyColumns = Object.entries(mapping)
		.filter(([, field]) => field === 'property')
		.map(([indexStr]) => ({ index: Number(indexStr), key: headers[Number(indexStr)]?.trim() }))
		.filter((column): column is { index: number; key: string } => Boolean(column.key));

	const seenEmails = new Set<string>();
	return rows.map((cells, rowIndex) => {
		const cell = (index: number | undefined) =>
			index === undefined ? '' : (cells[index]?.trim() ?? '');

		const contact: ContactImport = { email: cell(owners.email) };
		const firstName = cell(owners.firstName);
		const lastName = cell(owners.lastName);
		const language = cell(owners.language);
		if (firstName) contact.firstName = firstName;
		if (lastName) contact.lastName = lastName;
		if (language) contact.language = language;

		const properties: Record<string, ContactPropertyValue> = {};
		for (const { index, key } of propertyColumns) {
			// CSV cells are always strings.
			const value = cell(index);
			if (value) properties[key] = value;
		}
		if (Object.keys(properties).length > 0) contact.properties = properties;

		let status: PreparedRowStatus = 'valid';
		if (!contact.email) {
			status = 'missing';
		} else if (!looksLikeEmail(contact.email)) {
			status = 'invalid';
		} else if (seenEmails.has(contact.email.toLowerCase())) {
			status = 'duplicate';
		} else {
			seenEmails.add(contact.email.toLowerCase());
		}
		return { row: rowIndex + 1, contact, status };
	});
}
