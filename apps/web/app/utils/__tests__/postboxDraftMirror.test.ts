/**
 * The pure half of the composer's device draft mirror ("keep and ask").
 *
 * What these cases protect:
 *   - LIKE-FOR-LIKE COMPARISON. A copy is only ever removed without asking when
 *     its fields equal the latest observed row (G1). That only works if the
 *     composer snapshot (`mirrorFieldsOf`) and the row (`mirrorFieldsOfRow`)
 *     normalize the same message to the same value: same defaults hydration
 *     renders, blank HTML treated alike, blocks serialized one way.
 *   - NOTHING IS "BLANK" OR "EQUAL" THAT A PERSON WOULD MISS. A reminder alone
 *     is a difference and is content.
 *   - RESTORE ASKS whenever the row is not provably the one the copy was taken
 *     against (G2), and never compares clocks with the server.
 *   - STORED-VALUE IDENTITY (`sameStoredValue`) tolerates what IndexedDB's
 *     structured clone changes (key order, dropped `undefined`) and nothing else,
 *     because conditional deletes are keyed on it.
 */
import { describe, expect, it } from 'vitest';
import {
	MIRROR_RETENTION_MS,
	canonicalBlocks,
	isBlankHtml,
	isBlankMirrorFields,
	isMirrorCopyExpired,
	mirrorFieldEqual,
	mirrorFieldsEqual,
	mirrorFieldsOf,
	mirrorFieldsOfLegacy,
	mirrorFieldsOfRow,
	pickNewest,
	restoreNeedsConfirmation,
	sameStoredValue,
	type LegacyMirrorEntry,
	type MirrorFieldSources,
	type MirrorFields,
} from '../postboxDraftMirror';
import type { DraftComposerMode } from '../postboxDraftFields';

const BLOCKS = [
	{ id: 'b1', type: 'heading', content: 'Invoice 4471' },
	{ id: 'b2', type: 'text', content: 'Hi Ines,' },
];

interface ComposerState {
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	bodyBlocks: unknown[];
	composerMode: DraftComposerMode;
	followUpRemindAt: number | null;
}

/** The composer's refs, as plain `{ value }` boxes. */
function refs(over: Partial<ComposerState> = {}): MirrorFieldSources {
	const state: ComposerState = {
		toAddresses: ['ines@northwind.studio'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Invoice 4471',
		bodyHtml: '<p>Hi Ines,</p>',
		bodyBlocks: [],
		composerMode: 'simple',
		followUpRemindAt: null,
		...over,
	};
	return {
		toAddresses: { value: state.toAddresses },
		ccAddresses: { value: state.ccAddresses },
		bccAddresses: { value: state.bccAddresses },
		subject: { value: state.subject },
		bodyHtml: { value: state.bodyHtml },
		bodyBlocks: { value: state.bodyBlocks },
		composerMode: { value: state.composerMode },
		followUpRemindAt: { value: state.followUpRemindAt },
	};
}

function fields(over: Partial<MirrorFields> = {}): MirrorFields {
	return {
		toAddresses: ['ines@northwind.studio'],
		ccAddresses: [],
		bccAddresses: [],
		subject: 'Invoice 4471',
		bodyHtml: '<p>Hi Ines,</p>',
		bodyBlocks: '[]',
		composerMode: 'simple',
		followUpRemindAt: null,
		...over,
	};
}

const EMPTY: MirrorFields = fields({
	toAddresses: [],
	subject: '',
	bodyHtml: '',
});

describe('mirrorFieldsOf vs mirrorFieldsOfRow', () => {
	it('normalizes a simple-mode composer and its saved row to equal fields', () => {
		const composer = mirrorFieldsOf(refs({ ccAddresses: ['ops@northwind.studio'] }));
		const row = mirrorFieldsOfRow({
			toAddresses: ['ines@northwind.studio'],
			ccAddresses: ['ops@northwind.studio'],
			bccAddresses: [],
			subject: 'Invoice 4471',
			bodyHtml: '<p>Hi Ines,</p>',
			composerMode: 'simple',
		});
		expect(composer).toEqual(row);
		expect(mirrorFieldsEqual(composer, row)).toBe(true);
	});

	it('normalizes a full-mode composer and its saved row (blocks as stored JSON) to equal fields', () => {
		const composer = mirrorFieldsOf(
			refs({ composerMode: 'full', bodyBlocks: BLOCKS, followUpRemindAt: 1_700_000_000_000 })
		);
		const row = mirrorFieldsOfRow({
			toAddresses: ['ines@northwind.studio'],
			subject: 'Invoice 4471',
			bodyHtml: '<p>Hi Ines,</p>',
			bodyBlocks: JSON.stringify(BLOCKS),
			composerMode: 'full',
			followUpRemindAt: 1_700_000_000_000,
		});
		expect(composer).toEqual(row);
		expect(composer.bodyBlocks).toBe(canonicalBlocks(BLOCKS));
	});

	it('defaults absent row fields the way hydration renders them', () => {
		expect(mirrorFieldsOfRow({})).toEqual({
			toAddresses: [],
			ccAddresses: [],
			bccAddresses: [],
			subject: '',
			bodyHtml: '',
			bodyBlocks: '[]',
			composerMode: 'simple',
			followUpRemindAt: null,
		});
		// A freshly mounted, untouched composer is the same message as an empty row.
		expect(mirrorFieldsOf(refs({ toAddresses: [], subject: '', bodyHtml: '' }))).toEqual(
			mirrorFieldsOfRow({})
		);
	});

	it('re-serializes the row blocks, so formatting of the stored JSON does not matter', () => {
		const pretty = JSON.stringify(BLOCKS, null, 2);
		expect(mirrorFieldsOfRow({ bodyBlocks: pretty }).bodyBlocks).toBe(canonicalBlocks(BLOCKS));
	});

	it('treats an empty or unparsable stored blocks string as no blocks', () => {
		expect(mirrorFieldsOfRow({ bodyBlocks: '' }).bodyBlocks).toBe('[]');
		expect(mirrorFieldsOfRow({ bodyBlocks: '{not json' }).bodyBlocks).toBe('[]');
	});

	// An editor that rebuilds a block in another key order has not changed it.
	it('ignores the key order inside blocks', () => {
		const reordered = BLOCKS.map(({ id, type, content }) => ({ content, type, id }));
		expect(mirrorFieldsOf(refs({ bodyBlocks: reordered })).bodyBlocks).toBe(
			mirrorFieldsOfRow({ bodyBlocks: JSON.stringify(BLOCKS) }).bodyBlocks
		);
	});

	it('copies the address lists, so later composer edits cannot reach into a snapshot', () => {
		const sources = refs();
		const snapshot = mirrorFieldsOf(sources);
		sources.toAddresses.value.push('late@northwind.studio');
		expect(snapshot.toAddresses).toEqual(['ines@northwind.studio']);
	});
});

describe('isBlankHtml', () => {
	it.each([
		'',
		'   ',
		'<p></p>',
		'<p><br></p>',
		'<div><br/></div>',
		'<p>&nbsp;</p>',
		'<p class="x"> </p>',
	])('treats %j as an empty editor', (html) => {
		expect(isBlankHtml(html)).toBe(true);
	});

	it.each(['<p>a</p>', 'plain text', '<p><img src="cid:logo"></p>', '<hr>'])(
		'treats %j as content',
		(html) => {
			expect(isBlankHtml(html)).toBe(false);
		}
	);
});

describe('mirrorFieldEqual / mirrorFieldsEqual', () => {
	it("treats the empty editor's `<p></p>` and the row's '' as the same body", () => {
		expect(
			mirrorFieldEqual('bodyHtml', fields({ bodyHtml: '<p></p>' }), fields({ bodyHtml: '' }))
		).toBe(true);
		expect(mirrorFieldsEqual(fields({ bodyHtml: '<p><br></p>' }), fields({ bodyHtml: '' }))).toBe(
			true
		);
	});

	it('sees a changed recipient (order included), subject, body or mode', () => {
		const base = fields({ toAddresses: ['a@x.test', 'b@x.test'] });
		expect(mirrorFieldsEqual(base, { ...base, toAddresses: ['b@x.test', 'a@x.test'] })).toBe(false);
		expect(mirrorFieldsEqual(base, { ...base, bccAddresses: ['c@x.test'] })).toBe(false);
		expect(mirrorFieldsEqual(base, { ...base, subject: 'Invoice 4472' })).toBe(false);
		expect(mirrorFieldsEqual(base, { ...base, bodyHtml: '<p>Hi Ines, one more</p>' })).toBe(false);
		expect(mirrorFieldsEqual(base, { ...base, composerMode: 'full' })).toBe(false);
	});

	it('treats a changed follow-up reminder as a difference', () => {
		expect(mirrorFieldsEqual(fields(), fields({ followUpRemindAt: 1_700_000_000_000 }))).toBe(
			false
		);
		expect(
			mirrorFieldEqual(
				'followUpRemindAt',
				fields({ followUpRemindAt: 1 }),
				fields({ followUpRemindAt: 2 })
			)
		).toBe(false);
	});

	it('treats different blocks as a difference', () => {
		expect(mirrorFieldsEqual(fields({ bodyBlocks: canonicalBlocks(BLOCKS) }), fields())).toBe(
			false
		);
	});

	it('lets unknown (legacy, null) blocks match any blocks on either side', () => {
		const legacy = fields({ bodyBlocks: null });
		const withBlocks = fields({ bodyBlocks: canonicalBlocks(BLOCKS) });
		expect(mirrorFieldEqual('bodyBlocks', legacy, withBlocks)).toBe(true);
		expect(mirrorFieldEqual('bodyBlocks', withBlocks, legacy)).toBe(true);
		expect(mirrorFieldsEqual(legacy, withBlocks)).toBe(true);
		// The wildcard covers blocks only: the rest still has to agree.
		expect(mirrorFieldsEqual(legacy, { ...withBlocks, subject: 'Other' })).toBe(false);
	});
});

describe('isBlankMirrorFields', () => {
	it('is blank for an untouched composer, including an empty contenteditable', () => {
		expect(isBlankMirrorFields(EMPTY)).toBe(true);
		expect(isBlankMirrorFields({ ...EMPTY, subject: '   ', bodyHtml: '<p><br></p>' })).toBe(true);
		expect(isBlankMirrorFields({ ...EMPTY, bodyBlocks: null })).toBe(true);
	});

	it('is not blank with only a follow-up reminder set', () => {
		expect(isBlankMirrorFields({ ...EMPTY, followUpRemindAt: 1_700_000_000_000 })).toBe(false);
	});

	it('is not blank with only blocks, only a recipient, or only a subject', () => {
		expect(isBlankMirrorFields({ ...EMPTY, bodyBlocks: canonicalBlocks(BLOCKS) })).toBe(false);
		expect(isBlankMirrorFields({ ...EMPTY, ccAddresses: ['ops@x.test'] })).toBe(false);
		expect(isBlankMirrorFields({ ...EMPTY, subject: 'Hi' })).toBe(false);
	});
});

describe('restoreNeedsConfirmation', () => {
	const row = fields();

	it('never asks when there is no row to overwrite', () => {
		expect(restoreNeedsConfirmation({ base: null }, null)).toBe(false);
		expect(restoreNeedsConfirmation({ base: fields({ subject: 'Old' }) }, null)).toBe(false);
	});

	it('asks when the copy recorded no row (legacy, or written before the row existed)', () => {
		expect(restoreNeedsConfirmation({ base: null }, row)).toBe(true);
	});

	it('does not ask when the row is still the one the copy was taken against', () => {
		expect(restoreNeedsConfirmation({ base: fields({ bodyHtml: '<p>Hi Ines,</p>' }) }, row)).toBe(
			false
		);
	});

	it('asks when the row changed since the copy was taken (text saved elsewhere)', () => {
		expect(
			restoreNeedsConfirmation(
				{ base: row },
				fields({ bodyHtml: '<p>Newer, from the other tab</p>' })
			)
		).toBe(true);
		expect(restoreNeedsConfirmation({ base: row }, fields({ followUpRemindAt: 5 }))).toBe(true);
	});
});

describe('isMirrorCopyExpired', () => {
	const now = 1_800_000_000_000;

	it('keeps a copy exactly at the retention boundary and expires it one millisecond later', () => {
		expect(isMirrorCopyExpired(now - MIRROR_RETENTION_MS, now)).toBe(false);
		expect(isMirrorCopyExpired(now - MIRROR_RETENTION_MS - 1, now)).toBe(true);
	});

	it('keeps a fresh copy, and one stamped in the future by a skewed clock', () => {
		expect(isMirrorCopyExpired(now - 1_000, now)).toBe(false);
		expect(isMirrorCopyExpired(now + 60_000, now)).toBe(false);
	});
});

describe('pickNewest', () => {
	it('returns null for no candidates', () => {
		expect(pickNewest([])).toBeNull();
	});

	it('returns the newest copy', () => {
		const picked = pickNewest([
			{ id: 'a', savedAt: 10 },
			{ id: 'b', savedAt: 30 },
			{ id: 'c', savedAt: 20 },
		]);
		expect(picked?.id).toBe('b');
	});

	it('keeps the first of a tie', () => {
		const picked = pickNewest([
			{ id: 'first', savedAt: 30 },
			{ id: 'second', savedAt: 30 },
		]);
		expect(picked?.id).toBe('first');
	});
});

describe('sameStoredValue', () => {
	it('ignores key order at every depth', () => {
		expect(
			sameStoredValue({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })
		).toBe(true);
	});

	it('ignores properties that are undefined (structured clone may drop them)', () => {
		expect(sameStoredValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
	});

	it('sees changed values, array order, and null vs missing', () => {
		expect(sameStoredValue({ a: 1 }, { a: 2 })).toBe(false);
		expect(sameStoredValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
		expect(sameStoredValue({ a: null }, {})).toBe(false);
		expect(sameStoredValue(undefined, { a: 1 })).toBe(false);
	});

	it('matches a stored copy against its structured clone', () => {
		const copy = {
			v: 2,
			fields: fields({ bodyBlocks: canonicalBlocks(BLOCKS) }),
			base: null,
			savedAt: 1,
			draftId: 'd1',
			inReplyTo: null,
		};
		expect(sameStoredValue(structuredClone(copy), copy)).toBe(true);
	});
});

describe('mirrorFieldsOfLegacy', () => {
	function legacy(over: Partial<LegacyMirrorEntry['fields']> = {}): LegacyMirrorEntry {
		return {
			fields: {
				toAddresses: ['ines@northwind.studio'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Invoice 4471',
				bodyHtml: '<p>Hi Ines,</p>',
				composerMode: 'simple',
				...over,
			},
			savedAt: 1_000,
			serverEditedAt: 500,
		};
	}

	it('records blocks as unknown (null) when the v1 entry never stored them', () => {
		const converted = mirrorFieldsOfLegacy(legacy());
		expect(converted.bodyBlocks).toBeNull();
		expect(converted.followUpRemindAt).toBeNull();
		expect(converted).toEqual({ ...fields(), bodyBlocks: null });
	});

	it('normalizes blocks the v1 entry did record (full mode), like the row', () => {
		const converted = mirrorFieldsOfLegacy(
			legacy({ composerMode: 'full', bodyBlocks: JSON.stringify(BLOCKS, null, 2) })
		);
		expect(converted.bodyBlocks).toBe(canonicalBlocks(BLOCKS));
		expect(converted.composerMode).toBe('full');
	});

	it('keeps a recorded reminder', () => {
		expect(mirrorFieldsOfLegacy(legacy({ followUpRemindAt: 42 })).followUpRemindAt).toBe(42);
	});
});
