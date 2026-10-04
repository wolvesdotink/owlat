/**
 * The offer scan's cleanup re-checks the row INSIDE each conditional delete
 * (amendment A8): a copy equal to the row when the scan started is kept if the
 * row moved on before the delete ran, for v2 copies and legacy entries alike.
 */
import { describe, expect, it } from 'vitest';
import { mirrorFieldsOfRow, type MirrorFields } from '../postboxDraftMirror';
import { PostboxDraftMirrorStore, mirrorCopyKey } from '../postboxDraftMirrorStore';
import { scanMirrorOffers, type MirrorScan } from '../postboxDraftMirrorScan';
import type { OfflineKvDriver } from '../postboxOfflineKvDriver';

/** structuredClone in and out; `beforeDelete` runs inside deleteIf, before the predicate. */
function driver(beforeDelete: () => void = () => {}) {
	const map = new Map<string, unknown>();
	const d: OfflineKvDriver & { map: Map<string, unknown> } = {
		map,
		persistent: true,
		get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
		set: async (key, value) => void map.set(key, structuredClone(value)),
		delete: async (key) => void map.delete(key),
		keys: async () => [...map.keys()],
		clear: async () => map.clear(),
		deleteIf: async (key, predicate) => {
			beforeDelete();
			if (!predicate(structuredClone(map.get(key)))) return false;
			map.delete(key);
			return true;
		},
	};
	return d;
}

const ROW_A = mirrorFieldsOfRow({ subject: 'A', toAddresses: ['ada@example.com'] });
const ROW_B = mirrorFieldsOfRow({ subject: 'B', toAddresses: ['ada@example.com'] });

function scan(
	latest: { row: MirrorFields | null },
	overrides: Partial<MirrorScan> = {}
): MirrorScan {
	return {
		ns: 'mbx-1',
		sessionId: 'me',
		draftId: 'draft-1',
		inReplyTo: null,
		row: ROW_A,
		live: new Set(),
		now: Date.now(),
		onScreen: () => mirrorFieldsOfRow({ subject: 'on screen' }),
		latestRow: () => latest.row,
		stillCurrent: () => true,
		...overrides,
	};
}

const legacyEntry = {
	fields: {
		toAddresses: ['ada@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'A',
		bodyHtml: '',
		composerMode: 'simple',
	},
	savedAt: Date.now(),
	serverEditedAt: 1,
};

describe('scanMirrorOffers — equality cleanup judged against the row as it is now', () => {
	it('deletes a legacy entry equal to the row', async () => {
		const d = driver();
		d.map.set('draft-mirror:mbx-1:draft-1', legacyEntry);
		const offers = await scanMirrorOffers(new PostboxDraftMirrorStore(d), scan({ row: ROW_A }));
		expect(offers).toEqual([]);
		expect(d.map.has('draft-mirror:mbx-1:draft-1')).toBe(false);
	});

	it('keeps a legacy entry when the row moved on before the delete ran', async () => {
		const latest = { row: ROW_A as MirrorFields | null };
		const d = driver(() => {
			latest.row = ROW_B;
		});
		d.map.set('draft-mirror:mbx-1:draft-1', legacyEntry);
		await scanMirrorOffers(new PostboxDraftMirrorStore(d), scan(latest));
		expect(d.map.has('draft-mirror:mbx-1:draft-1')).toBe(true);
	});

	it('keeps a legacy entry when the scan was superseded before the delete ran', async () => {
		let current = true;
		const d = driver(() => {
			current = false;
		});
		d.map.set('draft-mirror:mbx-1:draft-1', legacyEntry);
		await scanMirrorOffers(
			new PostboxDraftMirrorStore(d),
			scan({ row: ROW_A }, { stillCurrent: () => current })
		);
		expect(d.map.has('draft-mirror:mbx-1:draft-1')).toBe(true);
	});

	it('keeps a v2 copy when the row moved on before the delete ran', async () => {
		const latest = { row: ROW_A as MirrorFields | null };
		const d = driver(() => {
			latest.row = ROW_B;
		});
		const key = mirrorCopyKey('mbx-1', 'draft-1', 'other', 'live');
		d.map.set(key, {
			v: 2,
			fields: ROW_A,
			base: ROW_A,
			savedAt: Date.now(),
			draftId: 'draft-1',
			inReplyTo: null,
		});
		await scanMirrorOffers(new PostboxDraftMirrorStore(d), scan(latest));
		expect(d.map.has(key)).toBe(true);
	});
});
