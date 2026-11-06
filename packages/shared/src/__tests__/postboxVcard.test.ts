import { describe, expect, it } from 'vitest';
import {
	VCARD_MAX_CARDS,
	VCARD_MAX_EMAILS_PER_CARD,
	VCARD_MAX_ENTRIES,
	VCARD_MAX_PHONES,
	VCARD_MAX_PHOTO_BYTES,
	mergeVcardPhones,
	normalizeVcardImportEntry,
	parseVcards,
	serializeVcards,
} from '../postboxVcard';

/** The cap on a name or an organization (`postboxVcardEntry.ts`). */
const VCARD_MAX_TEXT_LENGTH = 256;

const crlf = (...lines: string[]) => `${lines.join('\r\n')}\r\n`;

describe('parseVcards', () => {
	it('reads a vCard 3.0 card with names, addresses, phones and postal addresses', () => {
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:3.0',
				'N:Lovelace;Ada;;Countess;',
				'FN:Ada Lovelace',
				'ORG:Analytical Engines;Research',
				'EMAIL;TYPE=INTERNET,HOME:Ada@Example.com',
				'item1.EMAIL;TYPE=INTERNET:ada@work.example.org',
				'TEL;TYPE=CELL,VOICE:+44 20 7946 0000',
				'TEL;TYPE=WORK:+44 20 7946 0001',
				'ADR;TYPE=HOME:;;12 St James\\, Square;London;;SW1Y 4JH;United Kingdom',
				'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
				' BBBB',
				'END:VCARD'
			)
		);
		expect(result.cardCount).toBe(1);
		expect(result.skippedWithoutEmail).toBe(0);
		expect(result.isTruncated).toBe(false);
		const shared = {
			displayName: 'Ada Lovelace',
			organization: 'Analytical Engines, Research',
			phones: [
				{ value: '+44 20 7946 0000', type: 'cell' },
				{ value: '+44 20 7946 0001', type: 'work' },
			],
			postalAddresses: [
				{
					type: 'home',
					street: '12 St James, Square',
					locality: 'London',
					postalCode: 'SW1Y 4JH',
					country: 'United Kingdom',
				},
			],
		};
		expect(result.entries).toEqual([
			{ email: 'ada@example.com', ...shared },
			{ email: 'ada@work.example.org', ...shared },
		]);
	});

	it('reads vCard 4.0: quoted multi-value types, tel: URIs and folded lines', () => {
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:4.0',
				'FN:Grace Brewster ',
				' Hopper',
				'EMAIL;TYPE="work,pref":grace@example.org',
				'TEL;VALUE=uri;TYPE="voice,cell":tel:+1-555-0100',
				'ADR;TYPE=work;LABEL="1 Navy Way\\nArlington":;;1 Navy Way;Arlington;VA;22201;USA',
				'END:VCARD'
			)
		);
		expect(result.entries).toEqual([
			{
				email: 'grace@example.org',
				displayName: 'Grace Brewster Hopper',
				phones: [{ value: '+1-555-0100', type: 'cell' }],
				postalAddresses: [
					{
						type: 'work',
						street: '1 Navy Way',
						locality: 'Arlington',
						region: 'VA',
						postalCode: '22201',
						country: 'USA',
					},
				],
			},
		]);
	});

	it('builds the name from N when FN is missing, and decodes 2.1 quoted-printable', () => {
		const result = parseVcards(
			[
				'BEGIN:VCARD',
				'VERSION:2.1',
				'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BC=',
				'rgen;;Dr.;',
				'EMAIL;HOME:juergen@example.de',
				'TEL;HOME;VOICE:030 1234',
				'END:VCARD',
			].join('\n')
		);
		expect(result.entries).toEqual([
			{
				email: 'juergen@example.de',
				displayName: 'Dr. Jürgen Müller',
				phones: [{ value: '030 1234', type: 'home' }],
			},
		]);
	});

	it('skips cards without an email address and counts them', () => {
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:3.0',
				'FN:Phone Only',
				'TEL:+1 555 0101',
				'END:VCARD',
				'BEGIN:VCARD',
				'VERSION:3.0',
				'FN:Bad Address',
				'EMAIL:not-an-address',
				'END:VCARD'
			)
		);
		expect(result).toEqual({
			entries: [],
			cardCount: 2,
			skippedWithoutEmail: 2,
			isTruncated: false,
		});
	});

	it('ignores lines outside a card and the properties of a nested card', () => {
		const result = parseVcards(
			crlf(
				'\ufeffEMAIL:outside@example.com',
				'BEGIN:VCARD',
				'VERSION:2.1',
				'FN:Boss',
				'EMAIL:boss@example.com',
				'AGENT:',
				'BEGIN:VCARD',
				'FN:Assistant',
				'EMAIL:assistant@example.com',
				'END:VCARD',
				'END:VCARD'
			)
		);
		expect(result.entries).toEqual([{ email: 'boss@example.com', displayName: 'Boss' }]);
	});

	it('bounds the cards read and the entries written per file', () => {
		const card = (n: number) =>
			`BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:person${n}@example.com\r\nEND:VCARD\r\n`;
		const many = Array.from({ length: VCARD_MAX_ENTRIES + 5 }, (_, n) => card(n)).join('');
		const capped = parseVcards(many);
		expect(capped.entries).toHaveLength(VCARD_MAX_ENTRIES);
		expect(capped.isTruncated).toBe(true);

		const noEmail = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nobody\r\nEND:VCARD\r\n';
		const cards = parseVcards(noEmail.repeat(VCARD_MAX_CARDS + 1));
		expect(cards.cardCount).toBe(VCARD_MAX_CARDS);
		expect(cards.isTruncated).toBe(true);

		const exact = parseVcards(noEmail.repeat(VCARD_MAX_CARDS));
		expect(exact.isTruncated).toBe(false);
	});

	it('keeps a few values per parameter, so a repeated one adds no work', () => {
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				`TEL${';PREF'.repeat(100_000)};CELL:+1 555 0100`,
				'EMAIL:many@example.com',
				'END:VCARD'
			)
		);
		// CELL comes after the kept values, so it is not read.
		expect(result.entries[0]!.phones).toEqual([{ value: '+1 555 0100' }]);
	});

	it('bounds addresses, phones and field lengths on one card', () => {
		const emails = Array.from(
			{ length: VCARD_MAX_EMAILS_PER_CARD + 3 },
			(_, n) => `EMAIL:a${n}@example.com`
		);
		const phones = Array.from({ length: VCARD_MAX_PHONES + 3 }, (_, n) => `TEL:+1 555 01${n}`);
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:3.0',
				`FN:${'x'.repeat(VCARD_MAX_TEXT_LENGTH * 4)}`,
				...emails,
				...phones,
				'END:VCARD'
			)
		);
		expect(result.entries).toHaveLength(VCARD_MAX_EMAILS_PER_CARD);
		expect(result.entries[0]!.phones).toHaveLength(VCARD_MAX_PHONES);
		expect(result.entries[0]!.displayName).toHaveLength(VCARD_MAX_TEXT_LENGTH);
	});
});

describe('normalizeVcardImportEntry', () => {
	it('strips control and bidi characters and rejects an unusable address', () => {
		expect(
			normalizeVcardImportEntry({
				email: ' Mailto:Eve@Example.com ',
				displayName: 'Eve\u202e\u0007 Evil\n',
				phones: [{ value: 'no digits' }, { value: '+1 555', type: 'satellite' as never }],
			})
		).toEqual({ email: 'eve@example.com', displayName: 'Eve Evil', phones: [{ value: '+1 555' }] });
		expect(normalizeVcardImportEntry({ email: `${'a'.repeat(250)}@example.com` })).toBeNull();
		expect(normalizeVcardImportEntry({ email: 'nobody' })).toBeNull();
	});

	it('is idempotent on its own output', () => {
		const once = normalizeVcardImportEntry({
			email: 'A@example.com',
			displayName: `  ${'n'.repeat(VCARD_MAX_TEXT_LENGTH + 10)} `,
			postalAddresses: [{ street: ' 1 Main St ', type: 'home' }, {}],
		});
		expect(normalizeVcardImportEntry(once!)).toEqual(once);
	});

	it('never leaves half a surrogate pair at the length cap', () => {
		const name = `${'a'.repeat(VCARD_MAX_TEXT_LENGTH - 1)}😀`;
		const entry = normalizeVcardImportEntry({ email: 'a@example.com', displayName: name });
		expect(entry!.displayName).toBe('a'.repeat(VCARD_MAX_TEXT_LENGTH - 1));
	});
});

describe('mergeVcardPhones', () => {
	it('keeps existing numbers first and drops the same number written differently', () => {
		expect(
			mergeVcardPhones(
				[{ value: '+1 555 0100', type: 'cell' }],
				[{ value: '+1-555-0100' }, { value: '+1 555 0199', type: 'work' }]
			)
		).toEqual([
			{ value: '+1 555 0100', type: 'cell' },
			{ value: '+1 555 0199', type: 'work' },
		]);
	});
});

describe('serializeVcards', () => {
	it('writes vCard 3.0 that parses back to the same entries', () => {
		const entries = [
			{
				email: 'ada@example.com',
				displayName: 'Ada; Lovelace, Countess',
				organization: 'Analytical Engines',
				phones: [{ value: '+44 20 7946 0000', type: 'cell' as const }],
				postalAddresses: [
					{
						type: 'home' as const,
						street: '12 St James Square',
						locality: 'London',
						country: 'United Kingdom',
					},
				],
			},
			{ email: 'linus@example.net' },
		];
		const text = serializeVcards(entries);
		expect(text.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n')).toBe(true);
		expect(text).toContain('FN:Ada\\; Lovelace\\, Countess\r\n');
		expect(parseVcards(text).entries).toEqual(entries);
	});

	it('folds long lines at 75 octets without splitting a character', () => {
		const name = 'ü'.repeat(100);
		const text = serializeVcards([{ email: 'u@example.com', displayName: name }]);
		for (const line of text.split('\r\n')) {
			expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
		}
		expect(parseVcards(text).entries[0]!.displayName).toBe(name);
	});

	it('writes nothing for an empty address book', () => {
		expect(serializeVcards([])).toBe('');
	});
});

/** A picture of `size` bytes that starts like a real file of the format. */
function pictureBase64(magic: readonly number[], size: number): string {
	const bytes = new Uint8Array(size);
	bytes.set(magic);
	return Buffer.from(bytes).toString('base64');
}
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A base64 value folded into 3.0 continuation lines of 74 characters. */
function folded(name: string, base64: string): string[] {
	const lines = [`${name}${base64.slice(0, 60)}`];
	for (let i = 60; i < base64.length; i += 74) lines.push(` ${base64.slice(i, i + 74)}`);
	return lines;
}

describe('vCard PHOTO', () => {
	it('reads a folded 3.0 inline picture into the first address only, typed from its bytes', () => {
		const base64 = pictureBase64(JPEG, 2048);
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:3.0',
				'FN:Grace Hopper',
				'EMAIL:grace@example.com',
				'EMAIL:hopper@example.org',
				// The card claims PNG; the bytes are a JPEG.
				...folded('PHOTO;ENCODING=b;TYPE=PNG:', base64),
				'TEL:+1 555 0100',
				'END:VCARD'
			)
		);
		expect(result.entries).toHaveLength(2);
		expect(result.entries[0]!.photo).toEqual({ mediaType: 'image/jpeg', base64 });
		expect(result.entries[1]!.photo).toBeUndefined();
		// The property after the picture is still read.
		expect(result.entries[0]!.phones).toEqual([{ value: '+1 555 0100' }]);
	});

	it('reads a 4.0 data URI', () => {
		const base64 = pictureBase64(PNG, 300);
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:4.0',
				'EMAIL:ada@example.com',
				`PHOTO:data:image/png;base64,${base64}`,
				'END:VCARD'
			)
		);
		expect(result.entries[0]!.photo).toEqual({ mediaType: 'image/png', base64 });
	});

	it('takes a picture of exactly the cap and skips a larger one without losing the card', () => {
		const atCap = pictureBase64(JPEG, VCARD_MAX_PHOTO_BYTES);
		const overCap = pictureBase64(JPEG, VCARD_MAX_PHOTO_BYTES + 1);
		const card = (email: string, base64: string) => [
			'BEGIN:VCARD',
			'VERSION:3.0',
			`EMAIL:${email}`,
			...folded('PHOTO;ENCODING=b;TYPE=JPEG:', base64),
			'ORG:Analytical Engines',
			'END:VCARD',
		];
		const result = parseVcards(
			crlf(...card('cap@example.com', atCap), ...card('big@example.com', overCap))
		);
		expect(result.entries.map((entry) => entry.email)).toEqual([
			'cap@example.com',
			'big@example.com',
		]);
		expect(result.entries[0]!.photo?.base64).toBe(atCap);
		expect(result.entries[1]!.photo).toBeUndefined();
		expect(result.entries[1]!.organization).toBe('Analytical Engines');
	});

	it('fetches no picture named by a URL and keeps no image that is not a raster picture', () => {
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
		const result = parseVcards(
			crlf(
				'BEGIN:VCARD',
				'VERSION:4.0',
				'EMAIL:url@example.com',
				'PHOTO;MEDIATYPE=image/jpeg:https://example.com/me.jpg',
				'END:VCARD',
				'BEGIN:VCARD',
				'VERSION:3.0',
				'EMAIL:svg@example.com',
				`PHOTO;ENCODING=b;TYPE=SVG:${svg}`,
				'END:VCARD',
				'BEGIN:VCARD',
				'VERSION:3.0',
				'EMAIL:broken@example.com',
				'PHOTO;ENCODING=b;TYPE=JPEG:/9j/not*base64',
				'END:VCARD'
			)
		);
		expect(result.entries.map((entry) => entry.photo)).toEqual([undefined, undefined, undefined]);
	});

	it('drops an oversized picture on the server-side normalization too', () => {
		const entry = normalizeVcardImportEntry({
			email: 'a@example.com',
			photo: { mediaType: 'image/png', base64: pictureBase64(JPEG, VCARD_MAX_PHOTO_BYTES + 3) },
		});
		expect(entry).toEqual({ email: 'a@example.com' });
	});

	it('writes the picture back out and reads it again', () => {
		const base64 = pictureBase64(JPEG, 1500);
		const entries = [
			{ email: 'grace@example.com', photo: { mediaType: 'image/jpeg' as const, base64 } },
		];
		const text = serializeVcards(entries);
		expect(text).toContain('PHOTO;ENCODING=b;TYPE=JPEG:');
		expect(parseVcards(text).entries).toEqual(entries);
	});
});
