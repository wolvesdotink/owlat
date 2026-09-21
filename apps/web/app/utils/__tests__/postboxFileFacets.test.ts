import { describe, expect, it } from 'vitest';
import {
	POSTBOX_FILE_KINDS,
	fileDateAfterMs,
	hasActiveFileFacets,
	isPreviewableFile,
	previewSliceFor,
	toggleFileKind,
} from '../postboxFileFacets';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe('fileDateAfterMs', () => {
	it('is a rolling window from now, not a calendar boundary', () => {
		expect(fileDateAfterMs('week', NOW)).toBe(NOW - 7 * DAY);
		expect(fileDateAfterMs('month', NOW)).toBe(NOW - 30 * DAY);
		expect(fileDateAfterMs('year', NOW)).toBe(NOW - 365 * DAY);
	});

	it('leaves "all" unbounded rather than reaching back an arbitrary distance', () => {
		expect(fileDateAfterMs('all', NOW)).toBeUndefined();
	});
});

describe('toggleFileKind', () => {
	it('adds and removes, keeping the facet row in its display order', () => {
		expect(toggleFileKind([], 'image')).toEqual(['image']);
		expect(toggleFileKind(['image'], 'pdf')).toEqual(['pdf', 'image']);
		expect(toggleFileKind(['pdf', 'image'], 'pdf')).toEqual(['image']);
	});

	it('un-ticking the last kind means "all", not "none"', () => {
		// An empty selection is the query's way of saying every kind; landing on
		// an empty result set after un-ticking would be a dead end.
		expect(toggleFileKind(['pdf'], 'pdf')).toEqual([]);
	});

	it('orders every kind exactly as the chip row does', () => {
		const all = POSTBOX_FILE_KINDS.map((o) => o.value);
		const shuffled = [...all].reverse();
		const built = shuffled.reduce<ReturnType<typeof toggleFileKind>>(
			(acc, kind) => toggleFileKind(acc, kind),
			[]
		);
		expect(built).toEqual(all);
	});
});

describe('hasActiveFileFacets', () => {
	const base = { kinds: [] as never[], dateRange: 'all' as const, fromAddress: null, query: '' };

	it('is false for the untouched view', () => {
		expect(hasActiveFileFacets(base)).toBe(false);
	});

	it('ignores whitespace typed into the search box', () => {
		expect(hasActiveFileFacets({ ...base, query: '   ' })).toBe(false);
	});

	it.each([
		['kinds', { ...base, kinds: ['pdf' as const] }],
		['date', { ...base, dateRange: 'week' as const }],
		['sender', { ...base, fromAddress: 'ines@example.com' }],
		['query', { ...base, query: 'contract' }],
	])('is true once %s narrows the list', (_label, state) => {
		expect(hasActiveFileFacets(state)).toBe(true);
	});
});

describe('isPreviewableFile', () => {
	it('accepts images and PDFs, parameters and casing included', () => {
		expect(isPreviewableFile('image/png')).toBe(true);
		expect(isPreviewableFile('IMAGE/JPEG')).toBe(true);
		expect(isPreviewableFile('application/pdf; version=1.7')).toBe(true);
	});

	it('rejects everything that would open into an error state', () => {
		expect(isPreviewableFile('application/zip')).toBe(false);
		expect(isPreviewableFile('text/csv')).toBe(false);
	});
});

describe('previewSliceFor', () => {
	const png = { contentType: 'image/png', filename: 'a.png' };
	const zip = { contentType: 'application/zip', filename: 'b.zip' };
	const pdf = { contentType: 'application/pdf', filename: 'c.pdf' };

	it('indexes into the previewable subset, not the raw list', () => {
		// `pdf` is third in the listing but second among the previewables — an
		// index taken from the full list would open the wrong file.
		expect(previewSliceFor([png, zip, pdf], pdf)).toEqual({
			attachments: [png, pdf],
			index: 1,
		});
	});

	it('returns null for a file with no overlay to open', () => {
		expect(previewSliceFor([png, zip, pdf], zip)).toBeNull();
	});
});
