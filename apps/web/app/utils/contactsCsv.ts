import { sanitizeCsvCell } from '@owlat/shared';
import Papa from 'papaparse';
import type { Id } from '@owlat/api/dataModel';
import { formatDateForCsv } from '~/utils/formatters';

export interface CsvContact {
	_id: Id<'contacts'>;
	email?: string;
	firstName?: string;
	lastName?: string;
	language?: string;
	source?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface CsvProperty {
	// string key into the per-contact property-values map; callers may pass a
	// branded Id<'contactProperties'> (assignable to string).
	readonly _id: string;
	readonly label: string;
}

/**
 * Build sanitized CSV text for a set of contacts plus their custom property
 * values. Single source of truth for the contacts export — used by both the
 * ExportModal and the bulk-operations composable so the column set and the
 * formula-injection sanitization can't drift apart.
 */
export function buildContactsCsv(
	contacts: CsvContact[],
	propertyValues: Record<string, Record<string, string>> | null | undefined,
	properties: ReadonlyArray<CsvProperty>,
): string {
	const headers = [
		'Email',
		'First Name',
		'Last Name',
		'Language',
		'Source',
		'Created At',
		'Updated At',
		...properties.map((p) => p.label),
	];
	const rows = contacts.map((contact) => {
		const values = propertyValues?.[contact._id] ?? {};
		return [
			contact.email ?? '',
			contact.firstName || '',
			contact.lastName || '',
			contact.language || '',
			contact.source ?? '',
			formatDateForCsv(contact.createdAt),
			formatDateForCsv(contact.updatedAt),
			...properties.map((p) => values[p._id] || ''),
		];
	});
	// Neutralize =/+/-/@ formula prefixes in untrusted values (names, custom
	// properties) — quoting alone does not stop spreadsheet formulas.
	const sanitized = rows.map((row) => row.map((cell) => sanitizeCsvCell(String(cell ?? ''))));
	return Papa.unparse({ fields: headers, data: sanitized });
}

/**
 * Parse a CSV/text file into rows of string cells, dropping fully blank rows.
 *
 * Single source of truth for the client-side file parse used by the contacts
 * CSV import and the blocklist import — both wrapped the same
 * `Papa.parse(file, { complete, error })` boilerplate (blank-row filter +
 * mapping Papa's first error to a message). Resolves with the non-blank rows;
 * rejects with an `Error` whose message is the (mapped) parse error so callers
 * can surface it however they like.
 */
export function parseCsvFile(file: File): Promise<string[][]> {
	return new Promise((resolve, reject) => {
		Papa.parse<string[]>(file, {
			complete: (results) => {
				if (results.errors.length > 0) {
					reject(new Error(results.errors[0]?.message ?? 'Unknown parsing error'));
					return;
				}
				const rows = results.data.filter((row) => row.some((cell) => cell.trim() !== ''));
				resolve(rows);
			},
			error: (parseError) => {
				if (parseError instanceof Error) {
					reject(parseError);
					return;
				}
				// Papa's error callback hands back an Error in the browser; be
				// defensive about a plain `{ message }` shape too.
				const message =
					typeof parseError === 'object' && parseError !== null && 'message' in parseError
						? String((parseError as { message: unknown }).message)
						: String(parseError);
				reject(new Error(message));
			},
		});
	});
}

/** Trigger a client-side CSV file download. */
export function downloadCsv(csv: string, filename: string): void {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.setAttribute('download', filename);
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}
