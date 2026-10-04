// @vitest-environment happy-dom
/**
 * usePostboxComposePageRequest: the compose page's side of its request record.
 * Leaving never drops the only copy of unsaved text (G4): every unfinished
 * leave parks the editor synchronously, and a return resolves each parked
 * snapshot on its own (merged into the seed, merged into the editor, stored as
 * a device copy the mirror offers back, or dropped because the row holds it).
 * Every write is fenced by the mount that claimed the request.
 *
 * Driven with the real `usePostboxComposeNav` (session state + sessionStorage)
 * and the real mirror store over an in-memory driver; the composer is a fake
 * exposing just what the page uses of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { OfflineKvDriver } from '~/utils/postboxOfflineStore';
import { MIRROR_FIELD_NAMES, type MirrorCopy, type MirrorFields } from '~/utils/postboxDraftMirror';
import { PostboxDraftMirrorStore, mirrorCopyKey } from '~/utils/postboxDraftMirrorStore';
import type { ParkableSnapshot } from '../usePostboxComposeRow';
import {
	usePostboxComposeNav,
	type ComposeRequest,
	type ComposeSpec,
	type RecoverySource,
} from '../usePostboxComposeNav';
import {
	composerSeedOf,
	foldRowless,
	parkLeave,
	seedWithParked,
	usePostboxComposePageRequest,
	type ComposePageComposer,
} from '../usePostboxComposePageRequest';

let mirrorStore: PostboxDraftMirrorStore;
vi.mock('~/utils/postboxDraftMirrorStore', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getPostboxDraftMirrorStore: () => mirrorStore,
}));

/**
 * IndexedDB-like: writes resolve on commit, values are cloned in and out with
 * the structured clone IndexedDB uses (which rejects a Vue proxy, as `put`
 * does). `lenient` clones through JSON instead, for cases about the import
 * logic rather than about what reaches the store (see the DataCloneError case).
 */
function memoryDriver(
	persistent = true,
	lenient = false
): OfflineKvDriver & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	const clone = <T>(value: T): T =>
		lenient
			? value === undefined
				? value
				: JSON.parse(JSON.stringify(value))
			: structuredClone(value);
	return {
		data,
		persistent,
		get: async <T>(key: string) =>
			(data.has(key) ? clone(data.get(key)) : undefined) as T | undefined,
		set: async (key, value) => {
			data.set(key, clone(value));
		},
		delete: async (key) => {
			data.delete(key);
		},
		keys: async () => [...data.keys()],
		clear: async () => data.clear(),
		deleteIf: async (key, predicate) => {
			if (!predicate(clone(data.get(key)))) return false;
			data.delete(key);
			return true;
		},
	};
}

let driver: ReturnType<typeof memoryDriver>;
let states: Record<string, unknown>;
const navigate = vi.fn(async (_target: unknown) => {});

beforeEach(() => {
	states = {};
	window.sessionStorage.clear();
	navigate.mockClear();
	vi.stubGlobal('navigateTo', navigate);
	vi.stubGlobal('useState', (key: string, init: () => unknown) => (states[key] ??= ref(init())));
	driver = memoryDriver();
	mirrorStore = new PostboxDraftMirrorStore(driver);
});

const MBX = 'mbx-1' as never;
const D1 = 'draft-1' as never;

function fields(overrides: Partial<MirrorFields> = {}): MirrorFields {
	return {
		toAddresses: [],
		ccAddresses: [],
		bccAddresses: [],
		subject: '',
		bodyHtml: '',
		bodyBlocks: '[]',
		composerMode: 'simple',
		followUpRemindAt: null,
		...overrides,
	};
}

const ALL = [...MIRROR_FIELD_NAMES];

/** A ready composer's snapshot: every field real. */
function readySnap(
	overrides: Partial<MirrorFields>,
	opts: { draftId?: string | null; base?: MirrorFields | null } = {}
): ParkableSnapshot {
	return {
		fields: fields(overrides),
		present: ALL,
		base: opts.base ?? null,
		draftId: (opts.draftId ?? null) as never,
		ready: true,
	};
}

interface FakeComposer extends ComposePageComposer {
	snap: ParkableSnapshot;
	create: (id: string) => void;
}

function fakeComposer(snap: ParkableSnapshot): FakeComposer {
	const listeners: ((id: never) => void)[] = [];
	const composer: FakeComposer = {
		snap,
		flush: vi.fn(async () => ({ ok: true as const, result: composer.snap.draftId })),
		parkable: vi.fn(() => composer.snap),
		rescanMirror: vi.fn(async () => {}),
		onCreated: vi.fn((listener) => {
			listeners.push(listener as (id: never) => void);
			return () => {};
		}),
		create: (id: string) => {
			for (const listener of listeners) listener(id as never);
		},
	} as unknown as FakeComposer;
	return composer;
}

/** One page instance: opens `key`, mounts a fake composer, binds it. */
function mountPage(
	key: string,
	snap: ParkableSnapshot,
	urlDraft?: { mailboxId: never; draftId: never }
) {
	const nav = usePostboxComposeNav();
	const composer = ref<ComposePageComposer | null>(null);
	const page = usePostboxComposePageRequest({ nav, composer });
	page.openRequest(key, urlDraft);
	const fake = fakeComposer(snap);
	if (page.seed.value) {
		composer.value = fake;
		page.bindComposer(fake);
	}
	/** The page goes away: park, and the composer ref empties. */
	const unmount = () => {
		page.parkOnLeave();
		composer.value = null;
	};
	return { nav, page, fake, unmount, composer };
}

const record = (key: string): ComposeRequest | null => usePostboxComposeNav().read(key);
/** A merge context: merges everything; its exact-snapshot save succeeds when `saved`. */
const mergeAll = (saved = false) => ({
	merge: vi.fn(() => true),
	persist: vi.fn(async () => ({ ok: saved })),
});

function source(overrides: Partial<RecoverySource>): RecoverySource {
	return {
		id: 'src',
		fields: fields(),
		present: ALL,
		base: null,
		rowless: false,
		mountId: 'm',
		parkedAt: 1,
		...overrides,
	};
}

function request(overrides: Partial<ComposeRequest> = {}): ComposeRequest {
	return {
		v: 1,
		createdAt: 0,
		mountId: 'm',
		mailboxId: MBX,
		requestNonce: 'nonce-1',
		sources: [],
		...overrides,
	};
}

describe('pure helpers', () => {
	it('seedWithParked lays the present fields over the seed as prefill keys', () => {
		const seed: ComposeSpec = {
			mailboxId: MBX,
			prefillSubject: 'Old',
			prefillTo: ['old@example.com'],
		};
		const next = seedWithParked(
			seed,
			source({
				fields: fields({
					subject: 'New',
					toAddresses: ['ada@example.com'],
					bodyBlocks: '[{"type":"text"}]',
					composerMode: 'full',
					followUpRemindAt: 5,
				}),
				present: ['subject', 'bodyBlocks', 'composerMode', 'followUpRemindAt'],
			})
		);
		expect(next).toEqual({
			mailboxId: MBX,
			prefillSubject: 'New',
			// Not present: the seed's value stays.
			prefillTo: ['old@example.com'],
			prefillBodyBlocks: [{ type: 'text' }],
			prefillComposerMode: 'full',
			prefillFollowUpRemindAt: 5,
		});
		expect(seed.prefillSubject).toBe('Old');
	});

	it('seedWithParked skips unknown or malformed blocks and copies lists', () => {
		const to = ['ada@example.com'];
		const legacy = seedWithParked(
			{ mailboxId: MBX },
			source({
				fields: fields({ bodyBlocks: null, toAddresses: to }),
				present: ['bodyBlocks', 'toAddresses'],
			})
		);
		expect(legacy).toEqual({ mailboxId: MBX, prefillTo: to });
		expect(legacy.prefillTo).not.toBe(to);
		const broken = seedWithParked(
			{ mailboxId: MBX },
			source({ fields: fields({ bodyBlocks: '{nope' }), present: ['bodyBlocks'] })
		);
		expect(broken).toEqual({ mailboxId: MBX });
	});

	it('foldRowless folds rowless snapshots oldest first, so the newest wins', () => {
		const older = source({
			id: 'older',
			rowless: true,
			parkedAt: 10,
			fields: fields({ subject: 'older subject', bodyHtml: '<p>older body</p>' }),
			present: ['subject', 'bodyHtml'],
		});
		const newer = source({
			id: 'newer',
			rowless: true,
			parkedAt: 20,
			fields: fields({ subject: 'newer subject' }),
			present: ['subject'],
		});
		const withRow = source({ id: 'row', rowless: false, parkedAt: 5 });
		// The newer one sits in `sources`, the older is `current`: order is by time.
		const req = request({ sources: [newer, withRow], current: older });
		const folded = foldRowless({ mailboxId: MBX, prefillTo: ['a@example.com'] }, req);
		expect(folded.seed).toEqual({
			mailboxId: MBX,
			prefillTo: ['a@example.com'],
			prefillSubject: 'newer subject',
			prefillBodyHtml: '<p>older body</p>',
		});
		expect(folded.folded.map((s) => s.id)).toEqual(['older', 'newer']);
		// The record is not changed: they stay recovery sources.
		expect(req.current).toBe(older);
		expect(req.sources).toEqual([newer, withRow]);
	});

	it('foldRowless leaves a seed without rowless snapshots as it is', () => {
		const seed = { mailboxId: MBX };
		const folded = foldRowless(seed, request({ current: source({ id: 'row' }) }));
		expect(folded.seed).toBe(seed);
		expect(folded.folded).toEqual([]);
	});

	it('composerSeedOf adds the nonce, and drops creation work once there is a row', () => {
		const seed: ComposeSpec = {
			mailboxId: MBX,
			prefillSubject: 'Fwd: Q3',
			forwardAttachmentsFromMessageId: 'msg-1' as never,
			attachPendingKey: 'p',
		};
		expect(composerSeedOf(request({ seed }))).toEqual({ ...seed, requestNonce: 'nonce-1' });
		expect(composerSeedOf(request({ seed, draftId: D1 }))).toEqual({
			mailboxId: MBX,
			prefillSubject: 'Fwd: Q3',
			requestNonce: 'nonce-1',
			draftId: D1,
		});
		expect(composerSeedOf(request())).toEqual({ mailboxId: MBX, requestNonce: 'nonce-1' });
	});

	it('parkLeave parks nothing when the text equals the row, and drops the seed text', () => {
		const row = fields({ subject: 'Saved' });
		const next = parkLeave(
			request({ seed: { mailboxId: MBX, prefillSubject: 'Saved' }, draftId: D1 }),
			readySnap({ subject: 'Saved' }, { draftId: D1, base: row }),
			'm',
			100
		);
		expect(next.current).toBeUndefined();
		expect(next.seed).toEqual({ mailboxId: MBX });
	});

	it('parkLeave parks nothing for a blank rowless composer with no seed text', () => {
		const next = parkLeave(
			request({ seed: { mailboxId: MBX } }),
			readySnap({ bodyHtml: '<p></p>' }),
			'm',
			1
		);
		expect(next.current).toBeUndefined();
		expect(next.seed).toEqual({ mailboxId: MBX });
	});

	it('parkLeave keeps a deliberate clear of seeded text', () => {
		const next = parkLeave(
			request({ seed: { mailboxId: MBX, prefillSubject: 'Hi' } }),
			readySnap({}),
			'm',
			1
		);
		expect(next.current).toMatchObject({ rowless: true, fields: fields() });
	});

	it('parkLeave keeps the seed text while the composer is not ready', () => {
		const seed: ComposeSpec = { mailboxId: MBX, draftId: D1, prefillSubject: 'Offline' };
		const next = parkLeave(
			request({ seed, draftId: D1 }),
			{
				fields: fields({ subject: 'Offline!' }),
				present: ['subject'],
				base: null,
				draftId: D1,
				ready: false,
			},
			'm',
			1
		);
		expect(next.seed).toEqual(seed);
		expect(next.current).toMatchObject({ present: ['subject'], base: null, rowless: false });
	});

	it('parkLeave parks nothing when nothing is present yet', () => {
		const next = parkLeave(
			request({ draftId: D1 }),
			{ fields: fields(), present: [], base: null, draftId: D1, ready: false },
			'm',
			1
		);
		expect(next.current).toBeUndefined();
	});
});

describe('opening a request', () => {
	it('claims the request and seeds the composer with its nonce', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, prefillSubject: 'Hi' });
		const { page } = mountPage(key, readySnap({ subject: 'Hi' }));
		expect(page.state.value).toEqual({ status: 'ready', key, mountId: record(key)!.mountId });
		expect(page.seed.value).toEqual({
			mailboxId: MBX,
			prefillSubject: 'Hi',
			requestNonce: record(key)!.requestNonce,
		});
	});

	it('gives every mount of one request the same nonce (one row)', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		const first = mountPage(key, readySnap({}));
		first.unmount();
		states = {}; // even across a reload
		const second = mountPage(key, readySnap({}));
		expect(second.page.seed.value!.requestNonce).toBe(first.page.seed.value!.requestNonce);
	});

	it('says an unknown key without a draft in the URL has expired', () => {
		const { page, fake } = mountPage('unknown', readySnap({}));
		expect(page.state.value).toEqual({ status: 'expired' });
		expect(page.seed.value).toBeNull();
		expect(record('unknown')).toBeNull();
		// Nothing to park, nothing to finish.
		page.parkOnLeave();
		page.finish();
		expect(fake.parkable).not.toHaveBeenCalled();
	});

	it('adopts an unknown key whose URL names a saved draft', () => {
		const { page } = mountPage('copied', readySnap({}, { draftId: D1 }), {
			mailboxId: 'mbx-2' as never,
			draftId: D1,
		});
		expect(page.state.value.status).toBe('ready');
		expect(page.seed.value).toEqual({
			mailboxId: 'mbx-2',
			draftId: D1,
			requestNonce: record('copied')!.requestNonce,
		});
	});

	it('says an expired request has expired, even though it once existed', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
			const key = usePostboxComposeNav().create({ mailboxId: MBX, prefillSubject: 'old' });
			vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
			expect(mountPage(key, readySnap({})).page.state.value).toEqual({ status: 'expired' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports whether the record still carries text the server may not hold', () => {
		const nav = usePostboxComposeNav();
		const fresh = mountPage(nav.create({ mailboxId: MBX }), readySnap({}));
		expect(fresh.page.carriesText()).toBe(true); // no row yet
		const bound = mountPage(
			nav.create({ mailboxId: MBX, draftId: D1 }),
			readySnap({}, { draftId: D1 })
		);
		expect(bound.page.carriesText()).toBe(false);
		const undo = mountPage(
			nav.create({ mailboxId: MBX, draftId: D1, prefillSubject: 'Offline' }),
			readySnap({}, { draftId: D1 })
		);
		expect(undo.page.carriesText()).toBe(true);
		expect(mountPage('unknown', readySnap({})).page.carriesText()).toBe(false);
	});
});

describe('G4: leaving before the composition has a row', () => {
	it('parks the fields, and a return shows them while keeping them as recovery sources', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, prefillSubject: 'Hi' });
		const a = mountPage(key, readySnap({ subject: 'Hi there', bodyHtml: '<p>Typed</p>' }));
		a.unmount();
		expect(a.fake.parkable).toHaveBeenCalledOnce();
		expect(record(key)!.current).toMatchObject({
			rowless: true,
			base: null,
			fields: { subject: 'Hi there', bodyHtml: '<p>Typed</p>' },
		});

		const b = mountPage(key, readySnap({}));
		expect(b.page.seed.value).toMatchObject({
			mailboxId: MBX,
			prefillSubject: 'Hi there',
			prefillBodyHtml: '<p>Typed</p>',
			requestNonce: record(key)!.requestNonce,
		});
		// Shown, but kept until a save holds it: the nonce may still name a row.
		expect(record(key)!.current?.rowless).toBe(true);
		expect(b.page.carriesText()).toBe(true);
	});

	it('offers rowless text instead of imposing it once the request has a row (G2)', async () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		const a = mountPage(key, readySnap({ subject: 'Parked A' }));
		a.unmount();
		// The create lands after the leave; another writer saves newer text B.
		a.fake.create(D1);
		const rowB = fields({ subject: 'Newer B' });
		const b = mountPage(key, readySnap({ subject: 'Newer B' }, { draftId: D1, base: rowB }));
		// The seed carries the row, not the parked text.
		expect(b.page.seed.value).toMatchObject({ draftId: D1 });
		expect(b.page.seed.value).not.toHaveProperty('prefillSubject');
		const context = mergeAll();
		b.page.beforeReady(rowB, context);
		// Never merged (no base to prove the row unchanged): stored as an offer.
		expect(context.merge).not.toHaveBeenCalled();
		await flushPromises();
		const offered = [...driver.data.values()] as MirrorCopy[];
		expect(offered.map((c) => c.fields.subject)).toEqual(['Parked A']);
		expect(offered[0]!.base).toBeNull();
	});

	it('re-judges folded rowless text when the nonce turns out to name a row', async () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		mountPage(key, readySnap({ subject: 'Parked A' })).unmount();
		// No row bound yet: the return shows the parked text…
		const b = mountPage(key, readySnap({ subject: 'Parked A' }));
		expect(b.page.seed.value).toMatchObject({ prefillSubject: 'Parked A' });
		// …then creation finds the existing row (newer text): it is offered.
		b.fake.create(D1);
		const rowB = fields({ subject: 'Newer B' });
		b.fake.snap = readySnap({ subject: 'Newer B' }, { draftId: D1, base: rowB });
		b.page.beforeReady(rowB, mergeAll());
		await flushPromises();
		expect(([...driver.data.values()] as MirrorCopy[]).map((c) => c.fields.subject)).toEqual([
			'Parked A',
		]);
		// And a save does not drop it from the record as if it had been merged.
		b.page.savedAcknowledged(D1);
		expect(record(key)!.current).toBeUndefined();
	});

	it('merges every rowless snapshot, the newest over the older', () => {
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: MBX });
		const mountId = nav.claim(key)!;
		nav.update(key, mountId, (req) => ({
			...req,
			sources: [
				source({
					id: 'old',
					rowless: true,
					parkedAt: 1,
					fields: fields({ subject: 'old', bodyHtml: '<p>old body</p>' }),
					present: ['subject', 'bodyHtml'],
				}),
			],
			current: source({
				id: 'new',
				rowless: true,
				parkedAt: 2,
				fields: fields({ subject: 'new' }),
				present: ['subject'],
			}),
		}));
		const b = mountPage(key, readySnap({}));
		expect(b.page.seed.value).toMatchObject({
			prefillSubject: 'new',
			prefillBodyHtml: '<p>old body</p>',
		});
	});

	it('keeps the parked seed when no device storage holds anything', () => {
		mirrorStore = new PostboxDraftMirrorStore(memoryDriver(false));
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		mountPage(key, readySnap({ subject: 'Only copy' })).unmount();
		states = {}; // a reload
		expect(record(key)!.current?.fields.subject).toBe('Only copy');
	});

	it('binds a row created after the leave, and runs creation work only once', () => {
		const key = usePostboxComposeNav().create({
			mailboxId: MBX,
			prefillSubject: 'Fwd: Q3',
			forwardAttachmentsFromMessageId: 'msg-1' as never,
		});
		const a = mountPage(key, readySnap({ subject: 'Fwd: Q3' }));
		a.unmount();
		a.fake.create('draft-9');
		expect(record(key)!.draftId).toBe('draft-9');
		expect(record(key)!.seed).not.toHaveProperty('forwardAttachmentsFromMessageId');
		// The parked text stays until it is known to be held.
		expect(record(key)!.current?.fields.subject).toBe('Fwd: Q3');

		const b = mountPage(key, readySnap({}, { draftId: 'draft-9' }));
		// The whole editor was parked, so the open's text is in the snapshot,
		// which is judged against the row instead of being imposed on it.
		expect(b.page.seed.value).toMatchObject({ draftId: 'draft-9' });
		expect(b.page.seed.value).not.toHaveProperty('prefillSubject');
		expect(record(key)!.current?.rowless).toBe(true);
		expect(b.page.seed.value).not.toHaveProperty('forwardAttachmentsFromMessageId');
	});

	it('ignores a late row from a mount a newer one replaced', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, prefillSubject: 'x' });
		const a = mountPage(key, readySnap({ subject: 'x' }));
		a.unmount();
		const b = mountPage(key, readySnap({ subject: 'x' }));
		a.fake.create('draft-late');
		expect(record(key)!.draftId).toBeUndefined();
		expect(record(key)!.mountId).toBe((b.page.state.value as { mountId: string }).mountId);
		b.fake.create('draft-late');
		expect(record(key)!.draftId).toBe('draft-late');
	});

	it('binds the composer once only', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		const a = mountPage(key, readySnap({}));
		a.page.bindComposer(a.fake);
		expect(a.fake.onCreated).toHaveBeenCalledOnce();
	});
});

describe('G4: leaving a composer that has not loaded its row', () => {
	it('parks only present fields, and a return offers them over the row’s other fields', async () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		const a = mountPage(key, {
			// The body is an empty stand-in: never loaded, never typed.
			fields: fields({ subject: 'Typed before load' }),
			present: ['subject'],
			base: null,
			draftId: D1,
			ready: false,
		});
		a.unmount();
		const parked = record(key)!.current!;
		expect(parked).toMatchObject({ present: ['subject'], base: null, rowless: false });

		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		const row = fields({
			subject: 'Saved',
			bodyHtml: '<p>Saved body</p>',
			toAddresses: ['ada@example.com'],
		});
		const context = mergeAll();
		b.page.beforeReady(row, context);
		await flushPromises();

		// Never merged without a base to compare against: offered instead.
		expect(context.merge).not.toHaveBeenCalled();
		const key2 = mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live');
		const copy = driver.data.get(key2) as MirrorCopy;
		expect(copy).toEqual({
			v: 2,
			fields: { ...row, subject: 'Typed before load' },
			base: null,
			savedAt: parked.parkedAt,
			draftId: 'draft-1',
			inReplyTo: null,
			// Only the subject is real; the body shown is the row's, never restored.
			present: ['subject'],
		});
		expect(record(key)!.current).toBeUndefined();
		expect(b.fake.rescanMirror).toHaveBeenCalledOnce();
	});
});

describe('G4: returning to text parked against a row', () => {
	beforeEach(() => {
		// The source bug in the DataCloneError case below would fail every import
		// here; these cases are about which snapshots are imported and dropped.
		driver = memoryDriver(true, true);
		mirrorStore = new PostboxDraftMirrorStore(driver);
	});

	/** Mount A edits a loaded, ready draft and leaves. */
	function leaveEdited(
		row: MirrorFields,
		edited: Partial<MirrorFields>,
		seed: Partial<ComposeSpec> = {}
	) {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1, ...seed });
		const a = mountPage(key, readySnap({ ...row, ...edited }, { draftId: D1, base: row }));
		a.unmount();
		return { key, parked: record(key)!.current! };
	}

	it('merges it when the row is unchanged, and drops it once its own save lands', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		expect(parked).toMatchObject({ base: row, present: ALL });

		const b = mountPage(key, readySnap({ subject: 'Edited' }, { draftId: D1, base: row }));
		const context = mergeAll(true);
		b.page.beforeReady(row, context);
		expect(context.merge).toHaveBeenCalledWith(parked.fields, parked.present);
		// Exactly the merged text is saved, ahead of any later edit.
		expect(context.persist).toHaveBeenCalledOnce();
		expect(record(key)!.current?.id).toBe(parked.id);
		await flushPromises();
		expect(record(key)!.current).toBeUndefined();
		expect(driver.data.size).toBe(0);
	});

	it('keeps a merged snapshot edited further and saved as other text (G1)', async () => {
		mirrorStore = new PostboxDraftMirrorStore(memoryDriver(false));
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'S' });
		const b = mountPage(key, readySnap({ subject: 'S' }, { draftId: D1, base: row }));
		// Its own save fails; the person types on and T is saved.
		b.page.beforeReady(row, mergeAll(false));
		await flushPromises();
		const rowT = fields({ subject: 'T' });
		b.fake.snap = readySnap({ subject: 'T' }, { draftId: D1, base: rowT });
		b.page.savedAcknowledged(D1);
		b.page.settleMerged();
		expect(record(key)!.current?.id).toBe(parked.id);
	});

	it('keeps a merged snapshot when its own save failed', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({ subject: 'Edited' }, { draftId: D1, base: row }));
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		expect(record(key)!.current?.id).toBe(parked.id);
	});

	it('drops a merged snapshot on a later save once the row holds it, with no device copy', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({ subject: 'Edited' }, { draftId: D1, base: row }));
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		expect(record(key)!.current?.id).toBe(parked.id);
		// The autosave of the merged text lands: the row now equals the snapshot.
		b.fake.snap = readySnap(
			{ subject: 'Edited' },
			{ draftId: D1, base: fields({ subject: 'Edited' }) }
		);
		b.page.settleMerged();
		expect(record(key)!.current).toBeUndefined();
	});

	it('drops a merged snapshot once a save leaves the row holding the editor', async () => {
		const row = fields({ subject: 'Saved', bodyBlocks: '[]' });
		const edited = { subject: 'Edited', bodyBlocks: '[{"b":1}]', composerMode: 'full' as const };
		const { key } = leaveEdited(row, edited);
		const b = mountPage(key, readySnap(edited, { draftId: D1, base: row }));
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		// The full-mode save landed: the row now holds the editor's text.
		b.fake.snap = readySnap(edited, { draftId: D1, base: fields(edited) });
		b.page.savedAcknowledged(D1);
		expect(record(key)!.current).toBeUndefined();
	});

	it('keeps a merged snapshot whose blocks a simple-mode save never stored', async () => {
		const row = fields({ subject: 'Saved', bodyBlocks: '[]' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited', bodyBlocks: '[{"b":1}]' });
		const b = mountPage(
			key,
			readySnap({ subject: 'Edited', bodyBlocks: '[{"b":1}]' }, { draftId: D1, base: row })
		);
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		// The simple-mode save stored the text but left the row's blocks alone.
		b.fake.snap = readySnap(
			{ subject: 'Edited', bodyBlocks: '[{"b":1}]' },
			{ draftId: D1, base: fields({ subject: 'Edited', bodyBlocks: '[]' }) }
		);
		b.page.savedAcknowledged(D1);
		expect(record(key)!.current?.id).toBe(parked.id);
		// The flush still binds the row.
		expect(record(key)!.draftId).toBe(D1);
	});

	it('keeps a merged snapshot when the flush wrote nothing (a scheduled row)', async () => {
		mirrorStore = new PostboxDraftMirrorStore(memoryDriver(false));
		const row = fields({ subject: 'Saved A' });
		const { key, parked } = leaveEdited(row, { subject: 'Unsaved B' });
		const b = mountPage(key, readySnap({ subject: 'Unsaved B' }, { draftId: D1, base: row }));
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		// Scheduled elsewhere: flush reports the id without writing; the row is still A.
		b.page.savedAcknowledged(D1);
		expect(record(key)!.current?.id).toBe(parked.id);
	});

	it('drops a merged snapshot on a simple-mode save when its blocks are the row’s', async () => {
		const row = fields({ subject: 'Saved' });
		const { key } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({ subject: 'Edited' }, { draftId: D1, base: row }));
		b.page.beforeReady(row, mergeAll());
		await flushPromises();
		b.fake.snap = readySnap(
			{ subject: 'Edited' },
			{ draftId: D1, base: fields({ subject: 'Edited' }) }
		);
		b.page.savedAcknowledged(D1);
		expect(record(key)!.current).toBeUndefined();
	});

	it('stores it as a device copy when the row moved on, then drops it from the record', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const moved = fields({ subject: 'Saved elsewhere' });
		const b = mountPage(key, readySnap({}, { draftId: D1, base: moved }));
		const context = mergeAll();
		b.page.beforeReady(moved, context);
		expect(context.merge).not.toHaveBeenCalled();
		await flushPromises();
		const copy = driver.data.get(
			mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live')
		) as MirrorCopy;
		expect(copy).toMatchObject({ fields: { subject: 'Edited' }, base: row, draftId: 'draft-1' });
		expect(record(key)!.current).toBeUndefined();
		expect(b.fake.rescanMirror).toHaveBeenCalledOnce();
	});

	it('stores it as a device copy when this mount edited the field again', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({}, { draftId: D1, base: row }));
		const context = {
			merge: vi.fn(() => false),
			persist: vi.fn(async () => ({ ok: false })),
		};
		b.page.beforeReady(row, context);
		await flushPromises();
		expect(driver.data.has(mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live'))).toBe(
			true
		);
		expect(context.persist).not.toHaveBeenCalled();
	});

	it('records the reply it answers on the stored copy', async () => {
		const row = fields({ subject: 'Re: Q3' });
		const { key, parked } = leaveEdited(
			row,
			{ bodyHtml: '<p>Reply</p>' },
			{
				inReplyToMessageId: 'msg-7' as never,
			}
		);
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		b.page.beforeReady(fields({ subject: 'Re: Q3 (moved)' }), mergeAll());
		await flushPromises();
		const copy = driver.data.get(
			mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live')
		) as MirrorCopy;
		expect(copy.inReplyTo).toBe('msg-7');
	});

	it('stores its own copy even when another session holds the same text', async () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const moved = fields({ subject: 'Moved' });
		const existingKey = mirrorCopyKey('mbx-1', 'draft-1', 'other-session', 'live');
		await mirrorStore.write(existingKey, {
			v: 2,
			fields: JSON.parse(JSON.stringify(parked.fields)) as MirrorFields,
			base: row,
			savedAt: 1,
			draftId: 'draft-1',
			inReplyTo: null,
		});
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		b.page.beforeReady(moved, mergeAll());
		await flushPromises();
		// Another session's live copy can be replaced at any time: not a holder.
		expect([...driver.data.keys()].sort()).toEqual(
			[existingKey, mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live')].sort()
		);
		expect(record(key)!.current).toBeUndefined();
		expect(b.fake.rescanMirror).toHaveBeenCalledOnce();
	});

	it('keeps it in the record when the device stores nothing', async () => {
		mirrorStore = new PostboxDraftMirrorStore(memoryDriver(false));
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		b.page.beforeReady(fields({ subject: 'Moved' }), mergeAll());
		await flushPromises();
		expect(record(key)!.current?.id).toBe(parked.id);
		expect(b.fake.rescanMirror).not.toHaveBeenCalled();
	});

	it('drops it when the row already holds it', async () => {
		const row = fields({ subject: 'Saved' });
		const { key } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		const context = mergeAll();
		b.page.beforeReady(fields({ subject: 'Edited' }), context);
		expect(record(key)!.current).toBeUndefined();
		expect(context.merge).not.toHaveBeenCalled();
		await flushPromises();
		expect(driver.data.size).toBe(0);
	});

	it('does nothing for a mount that lost the request', () => {
		const row = fields({ subject: 'Saved' });
		const { key, parked } = leaveEdited(row, { subject: 'Edited' });
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		mountPage(key, readySnap({}, { draftId: D1 }));
		const context = mergeAll();
		b.page.beforeReady(row, context);
		expect(context.merge).not.toHaveBeenCalled();
		expect(record(key)!.current?.id).toBe(parked.id);
	});

	it('merges only one snapshot and offers the rest', async () => {
		const row = fields({ subject: 'Saved' });
		const nav = usePostboxComposeNav();
		const key = nav.create({ mailboxId: MBX, draftId: D1 });
		const mountId = nav.claim(key)!;
		const older = source({
			id: 'older',
			base: row,
			fields: fields({ subject: 'older' }),
			parkedAt: 1,
		});
		const newer = source({
			id: 'newer',
			base: row,
			fields: fields({ subject: 'newer' }),
			parkedAt: 2,
		});
		nav.update(key, mountId, (req) => ({ ...req, sources: [older], current: newer }));
		const b = mountPage(key, readySnap({}, { draftId: D1, base: row }));
		const context = mergeAll(true);
		b.page.beforeReady(row, context);
		// The newest (current) is merged; the older one becomes a device copy.
		expect(context.merge).toHaveBeenCalledOnce();
		expect(context.merge).toHaveBeenCalledWith(newer.fields, newer.present);
		await flushPromises();
		expect(driver.data.has(mirrorCopyKey('mbx-1', 'draft-1', 'parked-older', 'live'))).toBe(true);
		expect(record(key)!.sources).toEqual([]);
		expect(record(key)!.current).toBeUndefined();
	});
});

describe('G4: a parked snapshot reaching IndexedDB', () => {
	// The record comes out of `useState`, which is deep-reactive, and IndexedDB's
	// `put` structured-clones its value (a proxy throws DataCloneError): the copy
	// must be built from plain values, or it is never stored nor offered.
	it('stores a snapshot with list fields and a base on a structured-clone store', async () => {
		const row = fields({ subject: 'Saved', toAddresses: ['ada@example.com'] });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ ...row, subject: 'Edited' }, { draftId: D1, base: row })).unmount();
		const parked = record(key)!.current!;
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		b.page.beforeReady(fields({ subject: 'Moved', toAddresses: ['ada@example.com'] }), mergeAll());
		await flushPromises();
		expect(driver.data.has(mirrorCopyKey('mbx-1', 'draft-1', `parked-${parked.id}`, 'live'))).toBe(
			true
		);
		expect(record(key)!.current).toBeUndefined();
	});
});

describe('G4: what a leave parks', () => {
	it('parks nothing when the text equals the row', () => {
		const row = fields({ subject: 'Saved' });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ subject: 'Saved' }, { draftId: D1, base: row })).unmount();
		expect(record(key)!.current).toBeUndefined();
		expect(record(key)!.sources).toEqual([]);
	});

	it('replaces its own earlier park (a pagehide, then the unmount)', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		const a = mountPage(key, readySnap({ subject: 'one' }, { draftId: D1, base: fields() }));
		a.page.parkOnLeave();
		const first = record(key)!.current!;
		a.fake.snap = readySnap({ subject: 'two' }, { draftId: D1, base: fields() });
		a.unmount();
		expect(record(key)!.sources).toEqual([]);
		expect(record(key)!.current).toMatchObject({ fields: { subject: 'two' } });
		expect(record(key)!.current!.id).not.toBe(first.id);
	});

	it('keeps an earlier mount’s unresolved snapshot when a new mount leaves (A1)', () => {
		const row = fields({ subject: 'Saved' });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ subject: 'From A' }, { draftId: D1, base: row })).unmount();
		const fromA = record(key)!.current!;

		// B leaves before its row loaded, with one field typed.
		const b = mountPage(key, {
			fields: fields({ bodyHtml: '<p>From B</p>' }),
			present: ['bodyHtml'],
			base: null,
			draftId: D1,
			ready: false,
		});
		b.unmount();
		const after = record(key)!;
		expect(after.sources).toEqual([fromA]);
		expect(after.current).toMatchObject({ present: ['bodyHtml'], base: null });
		expect(after.current!.id).not.toBe(fromA.id);
	});

	it('keeps the earlier snapshot even when the new mount’s text is saved', () => {
		const row = fields({ subject: 'Saved' });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ subject: 'From A' }, { draftId: D1, base: row })).unmount();
		const fromA = record(key)!.current!;
		mountPage(key, readySnap({ subject: 'Saved' }, { draftId: D1, base: row })).unmount();
		expect(record(key)!.sources).toEqual([fromA]);
		expect(record(key)!.current).toBeUndefined();
	});

	it('does not park for a mount that lost the request', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		const a = mountPage(key, readySnap({ subject: 'A' }, { draftId: D1, base: fields() }));
		mountPage(key, readySnap({}, { draftId: D1 }));
		a.unmount();
		expect(record(key)!.current).toBeUndefined();
	});
});

describe('finishing', () => {
	it('forgets the record on a send or discard, and parks nothing after', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, prefillSubject: 'x' });
		const a = mountPage(key, readySnap({ subject: 'x' }));
		a.page.finish();
		expect(a.page.isFinished()).toBe(true);
		expect(record(key)).toBeNull();
		a.unmount();
		expect(a.fake.parkable).not.toHaveBeenCalled();
		expect(record(key)).toBeNull();
		// A late row does not resurrect it.
		a.fake.create('draft-1');
		expect(record(key)).toBeNull();
	});

	it('keeps unseen parked text when a send ends the composition (G1)', async () => {
		mirrorStore = new PostboxDraftMirrorStore(memoryDriver(false));
		const row = fields({ subject: 'Saved A' });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ subject: 'Unsaved B' }, { draftId: D1, base: row })).unmount();
		// Back: the row moved on to C, so B is to be offered, but storing it fails.
		const rowC = fields({ subject: 'Newer C' });
		const b = mountPage(key, readySnap({ subject: 'Newer C' }, { draftId: D1, base: rowC }));
		b.page.beforeReady(rowC, mergeAll());
		await flushPromises();
		expect(record(key)!.sources.concat(record(key)!.current ?? [])).toHaveLength(1);
		// C is sent: B was never shown, so it is not resolved by that.
		b.page.finish();
		await flushPromises();
		const kept = record(key)!;
		expect(
			[...kept.sources, ...(kept.current ? [kept.current] : [])].map((s) => s.fields.subject)
		).toEqual(['Unsaved B']);
		expect(kept.seed).toBeUndefined();
	});

	it('moves unseen parked text to a copy the next new message offers, then forgets', async () => {
		const row = fields({ subject: 'Saved A' });
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, readySnap({ subject: 'Unsaved B' }, { draftId: D1, base: row })).unmount();
		const b = mountPage(key, readySnap({ subject: 'Saved A' }, { draftId: D1, base: row }));
		// Not judged yet (the row never loaded here): the send ends it anyway.
		b.page.finish();
		await flushPromises();
		expect(record(key)).toBeNull();
		const copies = [...driver.data.values()] as MirrorCopy[];
		expect(copies).toHaveLength(1);
		expect(copies[0]).toMatchObject({
			draftId: null,
			base: null,
			fields: { subject: 'Unsaved B' },
		});
	});

	it('keeps the presence mask of a snapshot parked before its row loaded', async () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX, draftId: D1 });
		mountPage(key, {
			fields: fields({ subject: 'Only this was typed' }),
			present: ['subject'],
			base: null,
			draftId: D1 as never,
			ready: false,
		}).unmount();
		const b = mountPage(key, readySnap({}, { draftId: D1 }));
		b.page.finish();
		await flushPromises();
		const [copy] = [...driver.data.values()] as MirrorCopy[];
		expect(copy).toMatchObject({
			present: ['subject'],
			fields: { subject: 'Only this was typed' },
		});
	});

	it('leaves a record a newer mount owns', () => {
		const key = usePostboxComposeNav().create({ mailboxId: MBX });
		const a = mountPage(key, readySnap({}));
		mountPage(key, readySnap({}));
		a.page.finish();
		expect(record(key)).not.toBeNull();
	});
});

describe('savedAcknowledged', () => {
	it('binds the row and drops the seed text, keeping the target', () => {
		const key = usePostboxComposeNav().create({
			mailboxId: MBX,
			draftId: D1,
			prefillSubject: 'Offline',
			inReplyToMessageId: 'msg-1' as never,
		});
		const a = mountPage(key, readySnap({ subject: 'Offline' }, { draftId: D1 }));
		expect(a.page.carriesText()).toBe(true);
		// A flush without the row holding the text (scheduled) keeps it.
		a.page.savedAcknowledged(D1);
		expect(record(key)!.seed).toMatchObject({ prefillSubject: 'Offline' });
		a.fake.snap = readySnap(
			{ subject: 'Offline' },
			{ draftId: D1, base: fields({ subject: 'Offline' }) }
		);
		a.page.savedAcknowledged(D1);
		expect(record(key)!.seed).toEqual({ mailboxId: MBX, draftId: D1, inReplyToMessageId: 'msg-1' });
		expect(record(key)!.draftId).toBe(D1);
		expect(a.page.carriesText()).toBe(false);
	});
});
