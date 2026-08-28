import { describe, it, expect } from 'vitest';
import {
	draftMirrorFieldsEqual,
	isBlankDraftFields,
	reconcileDraftMirror,
	type DraftMirrorEntry,
	type DraftMirrorFields,
} from '../postboxDraftMirror';
import { PostboxDraftMirrorStore } from '../postboxDraftMirrorStore';
import type { OfflineKvDriver } from '../postboxOfflineStore';

function fields(over: Partial<DraftMirrorFields> = {}): DraftMirrorFields {
	return {
		toAddresses: ['ines@northwind.studio'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Invoice 4471',
		bodyHtml: '<p>Hi Ines,</p>',
		composerMode: 'simple',
		...over,
	};
}

function mirror(over: Partial<DraftMirrorEntry> = {}): DraftMirrorEntry {
	return { fields: fields(), savedAt: 1_000, serverEditedAt: 500, ...over };
}

/** Minimal in-memory driver standing in for IndexedDB. */
function memoryDriver(): OfflineKvDriver & { map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		map,
		async get<T>(key: string) {
			return map.get(key) as T | undefined;
		},
		async set(key, value) {
			map.set(key, JSON.parse(JSON.stringify(value)));
		},
		async delete(key) {
			map.delete(key);
		},
		async keys() {
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
	};
}

describe('draftMirrorFieldsEqual', () => {
	it('ignores key order and treats an absent bodyBlocks as an empty one', () => {
		const a: DraftMirrorFields = {
			composerMode: 'simple',
			bodyHtml: '<p>Hi</p>',
			subject: 'S',
			bccAddresses: [],
			ccAddresses: [],
			toAddresses: ['a@b.c'],
		};
		const b = fields({ subject: 'S', bodyHtml: '<p>Hi</p>', toAddresses: ['a@b.c'] });
		expect(draftMirrorFieldsEqual(a, b)).toBe(true);
		expect(draftMirrorFieldsEqual(a, { ...b, bodyBlocks: undefined })).toBe(true);
	});

	it('sees a changed recipient, subject or body', () => {
		const base = fields();
		expect(draftMirrorFieldsEqual(base, fields({ subject: 'Invoice 4472' }))).toBe(false);
		expect(draftMirrorFieldsEqual(base, fields({ toAddresses: [] }))).toBe(false);
		expect(draftMirrorFieldsEqual(base, fields({ bodyHtml: '<p>Hi Ines, one more</p>' }))).toBe(
			false
		);
	});
});

describe('isBlankDraftFields', () => {
	it('treats an empty contenteditable as blank', () => {
		const blank = fields({ toAddresses: [], subject: '  ', bodyHtml: '<p><br></p>' });
		expect(isBlankDraftFields(blank)).toBe(true);
		expect(isBlankDraftFields(fields({ toAddresses: [], subject: '', bodyHtml: '' }))).toBe(true);
	});

	it('is not blank once anything real is typed', () => {
		expect(isBlankDraftFields(fields({ toAddresses: [], subject: '', bodyHtml: '<p>a</p>' }))).toBe(
			false
		);
		expect(isBlankDraftFields(fields({ subject: '', bodyHtml: '' }))).toBe(false);
	});
});

describe('reconcileDraftMirror', () => {
	it('offers nothing when there is no mirror', () => {
		expect(reconcileDraftMirror({ mirror: null, serverEditedAt: 10, serverFields: fields() })).toBe(
			'none'
		);
	});

	it('offers a mirror of a composition that never reached the server', () => {
		expect(
			reconcileDraftMirror({ mirror: mirror(), serverEditedAt: null, serverFields: null })
		).toBe('restore');
	});

	it('offers nothing for a mirror of a blank composer', () => {
		const blank = mirror({ fields: fields({ toAddresses: [], subject: '', bodyHtml: '<br>' }) });
		expect(reconcileDraftMirror({ mirror: blank, serverEditedAt: null, serverFields: null })).toBe(
			'none'
		);
	});

	it('offers the mirror when it holds text the server row never received', () => {
		expect(
			reconcileDraftMirror({
				mirror: mirror({ serverEditedAt: 500 }),
				serverEditedAt: 500,
				serverFields: fields({ bodyHtml: '<p>Hi</p>' }),
			})
		).toBe('restore');
	});

	it('offers nothing once the server row already matches the mirror', () => {
		expect(
			reconcileDraftMirror({
				mirror: mirror({ serverEditedAt: 500 }),
				serverEditedAt: 500,
				serverFields: fields(),
			})
		).toBe('none');
	});

	it('lets a server row saved AFTER the mirror win, however the clocks disagree', () => {
		// The mirror was taken against lastEditedAt=500; the row has since moved
		// to 900 (another tab, another device). Its `savedAt` is far in the future
		// of both, and must not matter.
		expect(
			reconcileDraftMirror({
				mirror: mirror({ serverEditedAt: 500, savedAt: 9_999_999 }),
				serverEditedAt: 900,
				serverFields: fields({ bodyHtml: '<p>Newer, from the other tab</p>' }),
			})
		).toBe('none');
	});

	it('still offers a mirror whose client clock runs behind the server', () => {
		// savedAt (client) is older than every server stamp — irrelevant, because
		// the reconcile only ever compares server clock to server clock.
		expect(
			reconcileDraftMirror({
				mirror: mirror({ serverEditedAt: 500, savedAt: 1 }),
				serverEditedAt: 500,
				serverFields: fields({ subject: 'Invoice 4471 (saved)' }),
			})
		).toBe('restore');
	});
});

describe('PostboxDraftMirrorStore', () => {
	it('round-trips a mirror per mailbox namespace', async () => {
		const store = new PostboxDraftMirrorStore(memoryDriver());
		await store.save('mbx1', 'draft1', mirror());
		expect(await store.load('mbx1', 'draft1')).toMatchObject({
			fields: { subject: 'Invoice 4471' },
		});
		// A different mailbox on the same device sees nothing.
		expect(await store.load('mbx2', 'draft1')).toBeNull();
	});

	it('clears a mirror without blocking the next one', async () => {
		const store = new PostboxDraftMirrorStore(memoryDriver());
		await store.save('mbx1', 'draft1', mirror());
		await store.clear('mbx1', 'draft1');
		expect(await store.load('mbx1', 'draft1')).toBeNull();
		expect(await store.save('mbx1', 'draft1', mirror({ savedAt: 2_000 }))).toBe(true);
		expect(await store.load('mbx1', 'draft1')).toMatchObject({ savedAt: 2_000 });
	});

	it('never resurrects a discarded draft, even from a write already in flight', async () => {
		const store = new PostboxDraftMirrorStore(memoryDriver());
		await store.save('mbx1', 'draft1', mirror());
		await store.discard('mbx1', 'draft1');
		// The debounced write that was scheduled before Discard now lands.
		expect(await store.save('mbx1', 'draft1', mirror({ savedAt: 2_000 }))).toBe(false);
		expect(await store.load('mbx1', 'draft1')).toBeNull();
	});

	it('refuses a discarded key in a fresh session too, via the stored tombstone', async () => {
		const driver = memoryDriver();
		await new PostboxDraftMirrorStore(driver).discard('mbx1', 'draft1');
		// A new store instance (new tab / next page load) over the same data.
		const next = new PostboxDraftMirrorStore(driver);
		expect(await next.load('mbx1', 'draft1')).toBeNull();
		expect(await next.save('mbx1', 'draft1', mirror())).toBe(false);
	});

	it('evicts the oldest mirrors past the cap', async () => {
		const driver = memoryDriver();
		const store = new PostboxDraftMirrorStore(driver);
		for (let i = 0; i < 25; i++) await store.save('mbx1', `draft${i}`, mirror());
		expect(await store.load('mbx1', 'draft0')).toBeNull();
		expect(await store.load('mbx1', 'draft24')).not.toBeNull();
		const mirrorKeys = [...driver.map.keys()].filter((k) => k.startsWith('draft-mirror:'));
		expect(mirrorKeys).toHaveLength(20);
	});

	it('degrades silently when the device refuses every write', async () => {
		const throwing: OfflineKvDriver = {
			get: async () => undefined,
			set: async () => {
				throw new Error('QuotaExceededError');
			},
			delete: async () => {},
			keys: async () => [],
			clear: async () => {},
		};
		const store = new PostboxDraftMirrorStore(throwing);
		await expect(store.save('mbx1', 'draft1', mirror())).resolves.toBe(false);
		await expect(store.load('mbx1', 'draft1')).resolves.toBeNull();
	});
});
