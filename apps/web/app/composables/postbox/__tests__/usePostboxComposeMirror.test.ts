/**
 * The composer's device draft mirror, "keep and ask" (plan v4, amendments
 * A1-A8): the wiring in `usePostboxComposeMirror`.
 *
 * The pure policy (field equality, confirmation rule, retention) and the
 * store's key handling have their own suites; what these cases pin is the part
 * only the wiring can get wrong, one deterministic sequence per case:
 *
 *   - WRITING: the session's own `live` copy is written on a debounce, against
 *     the loaded row, only once the row has loaded (G3), only committed writes
 *     count, and dispose / retire order themselves behind writes in flight;
 *   - OFFERING: other sessions' copies are offered newest first, deleted only
 *     when they equal the row and still hold what the scan read (G1), never
 *     while their session is alive, and a scan that raced a draft change is
 *     dropped;
 *   - RESTORE: asks when the row is not provably the copy's base (G2), sets
 *     the editor's unsaved text aside first, re-checks before applying, writes
 *     through autosave, and removes the source only after the server has it;
 *   - KEEP, MIGRATION and RETENTION: conditional deletes, provisional slots
 *     moved onto the created row (even after dispose), and the sweep sparing
 *     live and offered copies.
 *
 * Storage is an in-memory driver that clones like IndexedDB (structuredClone,
 * so a reactive proxy is refused as IndexedDB refuses it), implements
 * `deleteIf` in one step, and can fail or hold any operation on demand so
 * interleavings are exact rather than timing-dependent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import { canonicalBlocks, type MirrorCopy, type MirrorFields } from '~/utils/postboxDraftMirror';
import type * as DraftMirrorStoreModule from '~/utils/postboxDraftMirrorStore';
import {
	PostboxDraftMirrorStore,
	mirrorCopyKey,
	provisionalDraftKey,
} from '~/utils/postboxDraftMirrorStore';
import type { OfflineKvDriver } from '~/utils/postboxOfflineStore';
import type { LatestDraftRow } from '../usePostboxComposeHydration';
import { usePostboxComposeTouched } from '../usePostboxComposeTouched';
import {
	DRAFT_MIRROR_DEBOUNCE_MS,
	usePostboxComposeMirror,
	type ComposeMirrorSources,
} from '../usePostboxComposeMirror';

// ── Storage ──────────────────────────────────────────────────────────────────

type DriverOp = 'get' | 'set' | 'delete' | 'keys' | 'deleteIf';

interface Gate {
	op: DriverOp;
	match: (key: string) => boolean;
	used: boolean;
	reached: Promise<void>;
	markReached: () => void;
	release: () => void;
	released: Promise<void>;
}

interface TestDriver extends OfflineKvDriver {
	map: Map<string, unknown>;
	/** Writes to keys this matches reject (the transaction aborted). */
	failSet: ((key: string) => boolean) | null;
	/** Runs inside `deleteIf` before the stored value is read (one-shot). */
	beforeDeleteIf: ((key: string) => void) | null;
	/** Hold the next `op` on a matching key until released. */
	gate: (op: DriverOp, match?: (key: string) => boolean) => Pick<Gate, 'reached' | 'release'>;
}

function memoryDriver(): TestDriver {
	const map = new Map<string, unknown>();
	const gates: Gate[] = [];

	async function pass(op: DriverOp, key: string) {
		const gate = gates.find((g) => !g.used && g.op === op && g.match(key));
		if (!gate) return;
		gate.used = true;
		gate.markReached();
		await gate.released;
	}

	const driver: TestDriver = {
		map,
		persistent: true,
		failSet: null,
		beforeDeleteIf: null,
		gate(op, match = () => true) {
			let markReached!: () => void;
			let release!: () => void;
			const reached = new Promise<void>((resolve) => (markReached = resolve));
			const released = new Promise<void>((resolve) => (release = resolve));
			gates.push({ op, match, used: false, reached, markReached, release, released });
			return { reached, release };
		},
		async get<T>(key: string) {
			await pass('get', key);
			const value = map.get(key);
			return (value === undefined ? undefined : structuredClone(value)) as T | undefined;
		},
		async set(key, value) {
			// IndexedDB clones synchronously inside put(): a proxy throws here.
			const cloned = structuredClone(value);
			await pass('set', key);
			if (driver.failSet?.(key)) throw new Error('transaction aborted');
			map.set(key, cloned);
		},
		async delete(key) {
			await pass('delete', key);
			map.delete(key);
		},
		async keys() {
			await pass('keys', '');
			return [...map.keys()];
		},
		async clear() {
			map.clear();
		},
		async deleteIf(key, predicate) {
			await pass('deleteIf', key);
			const hook = driver.beforeDeleteIf;
			driver.beforeDeleteIf = null;
			hook?.(key);
			// One transaction: read, judge, delete, with nothing in between.
			const current = map.has(key) ? structuredClone(map.get(key)) : undefined;
			if (!predicate(current)) return false;
			map.delete(key);
			return true;
		},
	};
	return driver;
}

let driver: TestDriver;
let store: PostboxDraftMirrorStore;
vi.mock('~/utils/postboxDraftMirrorStore', async (importActual) => {
	const actual = await importActual<typeof DraftMirrorStoreModule>();
	return { ...actual, getPostboxDraftMirrorStore: () => store };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NS = 'mbx-1';
const DRAFT = 'draft-1';
const NOW = new Date('2026-10-04T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
const BLOCKS = [{ id: 'b1', type: 'text', content: 'Hi' }] as unknown as EditorBlock[];

const ROW: MirrorFields = {
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	bccAddresses: [],
	subject: 'Quarterly numbers',
	bodyHtml: '<p>Saved text</p>',
	bodyBlocks: '[]',
	composerMode: 'simple',
	followUpRemindAt: null,
};

const BLANK: MirrorFields = {
	toAddresses: [],
	ccAddresses: [],
	bccAddresses: [],
	subject: '',
	bodyHtml: '',
	bodyBlocks: '[]',
	composerMode: 'simple',
	followUpRemindAt: null,
};

function loaded(fields: MirrorFields, state: 'draft' | 'scheduled' = 'draft'): LatestDraftRow {
	return { status: 'loaded', fields, state, lastEditedAt: null };
}

/** Session ids this test wrote copies for (anything else is the composer's own). */
const seededSessions = new Set<string>();

function copyOf(fields: Partial<MirrorFields>, over: Partial<MirrorCopy> = {}): MirrorCopy {
	return {
		v: 2,
		fields: { ...ROW, ...fields },
		base: ROW,
		savedAt: NOW - 60_000,
		draftId: DRAFT,
		inReplyTo: null,
		...over,
	};
}

/** Store another session's copy directly, as that session would have. */
function seed(draftKey: string, sessionId: string, copy: MirrorCopy, slot = 'live'): string {
	seededSessions.add(sessionId);
	const key = mirrorCopyKey(NS, draftKey, sessionId, slot);
	driver.map.set(key, structuredClone(copy));
	return key;
}

function stored(key: string): MirrorCopy | undefined {
	return driver.map.get(key) as MirrorCopy | undefined;
}

/** Keys of copies written by the composer under test (not seeded ones). */
function ownKeys(): string[] {
	return [...driver.map.keys()].filter((key) => {
		const parts = key.split(':');
		return key.startsWith('draft-mirror:v2:') && !seededSessions.has(parts[4]!);
	});
}

function ownKey(slotSuffix: string): string | undefined {
	return ownKeys().find((key) => key.endsWith(slotSuffix));
}

function sessionOf(key: string): string {
	return key.split(':')[4]!;
}

async function settle() {
	for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function afterDebounce() {
	await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
	await settle();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

// ── Web Locks ────────────────────────────────────────────────────────────────

function setLocks(locks: unknown) {
	Object.defineProperty(navigator, 'locks', { value: locks, configurable: true, writable: true });
}

/** A lock manager that reports every requested (and pre-held) lock as held. */
function fakeLocks(preHeldSessions: string[] = []) {
	const held = new Set(preHeldSessions.map((s) => `owlat-mirror:${s}`));
	return {
		held,
		request: vi.fn((name: string, _opts: unknown, cb: () => Promise<void>) => {
			held.add(name);
			return Promise.resolve(cb()).finally(() => held.delete(name));
		}),
		query: vi.fn(async () => ({
			held: [...held].map((name) => ({ name, mode: 'exclusive' })),
			pending: [],
		})),
	};
}

// ── The composer ─────────────────────────────────────────────────────────────

interface OpenOptions {
	draftId?: string | null;
	inReplyTo?: string;
	ready?: boolean;
	row?: LatestDraftRow;
	/** The on-screen fields at mount (default: the row's, as hydrated). */
	fields?: MirrorFields;
	/** Use a deep `ref` for the row, as `usePostboxComposeRow` does. */
	deepRow?: boolean;
}

function openComposer(options: OpenOptions = {}) {
	const onScreen = options.fields ?? ROW;
	const draftId = ref<string | null>(options.draftId === undefined ? DRAFT : options.draftId);
	const ready = ref(options.ready ?? true);
	const draftState = ref<'draft' | 'pending_send' | 'scheduled'>('draft');
	const initialRow = options.row ?? loaded(ROW);
	const latestRow: Ref<LatestDraftRow> = options.deepRow
		? ref<LatestDraftRow>(initialRow)
		: shallowRef<LatestDraftRow>(initialRow);
	const refs = {
		toAddresses: ref<string[]>([...onScreen.toAddresses]),
		ccAddresses: ref<string[]>([...onScreen.ccAddresses]),
		bccAddresses: ref<string[]>([...onScreen.bccAddresses]),
		subject: ref(onScreen.subject),
		bodyHtml: ref(onScreen.bodyHtml),
		bodyBlocks: ref<EditorBlock[]>(JSON.parse(onScreen.bodyBlocks ?? '[]') as EditorBlock[]),
		composerMode: ref<'simple' | 'full'>(onScreen.composerMode),
		followUpRemindAt: ref<number | null>(onScreen.followUpRemindAt),
	};
	const listeners = new Set<(id: string) => void>();
	const autosave = {
		ensureDraft: vi.fn(async () => {
			draftId.value = 'draft-new';
			return 'draft-new';
		}),
		pause: vi.fn(),
		resume: vi.fn(),
		drain: vi.fn(async () => {}),
		persistRestored: vi.fn(async (_snapshot: Record<string, unknown>) => ({ ok: true })),
		onCreated: vi.fn((listener: (id: string) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	};
	const scope = effectScope();
	const { mirror, touched } = scope.run(() => {
		const touched = usePostboxComposeTouched(refs, []);
		const sources = {
			mailboxId: NS,
			draftId,
			inReplyToMessageId: options.inReplyTo,
			ready,
			draftState,
			latestRow,
			touched,
			...refs,
			autosave,
		} as unknown as ComposeMirrorSources;
		return { mirror: usePostboxComposeMirror(sources), touched };
	})!;
	return {
		mirror,
		touched,
		refs,
		draftId,
		ready,
		draftState,
		latestRow,
		autosave,
		/** What autosave does once `drafts.create` answered. */
		created(id: string) {
			draftId.value = id;
			for (const listener of listeners) listener(id);
		},
		close: () => scope.stop(),
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	driver = memoryDriver();
	store = new PostboxDraftMirrorStore(driver);
	seededSessions.clear();
	setLocks(undefined);
});

afterEach(() => {
	delete (navigator as { locks?: unknown }).locks;
	vi.useRealTimers();
});

// ── Writing ──────────────────────────────────────────────────────────────────

describe('writing the live copy', () => {
	it('writes a debounced live copy whose base is the loaded row', async () => {
		const c = openComposer();
		c.refs.subject.value = 'Quarterly numbers (draft 2)';

		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS - 1);
		await settle();
		expect(ownKeys()).toEqual([]);

		await afterDebounce();
		const key = ownKey(':live')!;
		expect(key).toBe(mirrorCopyKey(NS, DRAFT, sessionOf(key), 'live'));
		expect(stored(key)).toMatchObject({
			v: 2,
			fields: { ...ROW, subject: 'Quarterly numbers (draft 2)' },
			base: ROW,
			draftId: DRAFT,
			inReplyTo: null,
			savedAt: NOW + DRAFT_MIRROR_DEBOUNCE_MS,
		});
		c.close();
	});

	// IndexedDB's structured clone refuses reactive proxies: a row held in a
	// deep `ref` must still be stored as a plain `base` (live copy and backup).
	// The other cases use a shallowRef, as usePostboxComposeRow does.
	it('writes the live copy when the row ref is deep', async () => {
		const c = openComposer({ deepRow: true });
		c.refs.subject.value = 'Edited against a deep row ref';
		await afterDebounce();
		expect(ownKey(':live')).toBeDefined();
		c.close();
	});

	it('writes nothing before the composer is ready, then writes once it is (G3)', async () => {
		const c = openComposer({ ready: false, row: { status: 'unknown' }, fields: BLANK });
		c.refs.subject.value = 'Typed while loading';
		await afterDebounce();
		expect(ownKeys()).toEqual([]);
		expect(await c.mirror.writeNow()).toBe(false);

		c.latestRow.value = loaded(ROW);
		c.ready.value = true;
		await settle();
		const copy = stored(ownKey(':live')!)!;
		expect(copy.fields.subject).toBe('Typed while loading');
		expect(copy.base).toEqual(ROW);
		c.close();
	});

	it('removes its own copy once the on-screen text equals the row again', async () => {
		const c = openComposer();
		c.refs.subject.value = 'Changed';
		await afterDebounce();
		expect(ownKey(':live')).toBeDefined();

		c.refs.subject.value = ROW.subject;
		await afterDebounce();
		expect(ownKeys()).toEqual([]);
		c.close();
	});

	it('keeps a failed write dirty and retries it with the next change', async () => {
		const c = openComposer();
		driver.failSet = () => true;
		c.refs.subject.value = 'First attempt';
		await afterDebounce();
		expect(ownKeys()).toEqual([]);

		driver.failSet = null;
		c.refs.bodyHtml.value = '<p>More text</p>';
		await afterDebounce();
		expect(stored(ownKey(':live')!)!.fields).toMatchObject({
			subject: 'First attempt',
			bodyHtml: '<p>More text</p>',
		});
		c.close();
	});

	it('retries a failed write when the composer becomes eligible again', async () => {
		const c = openComposer();
		driver.failSet = () => true;
		c.refs.subject.value = 'Failed once';
		await afterDebounce();
		expect(ownKeys()).toEqual([]);

		driver.failSet = null;
		c.draftState.value = 'scheduled';
		await settle();
		c.draftState.value = 'draft';
		await settle();
		expect(stored(ownKey(':live')!)!.fields.subject).toBe('Failed once');
		c.close();
	});

	it('resolves writeNow true only when the on-screen text is held', async () => {
		const c = openComposer();
		c.refs.subject.value = 'Leaving now';

		driver.failSet = () => true;
		expect(await c.mirror.writeNow()).toBe(false);
		expect(ownKeys()).toEqual([]);

		driver.failSet = null;
		expect(await c.mirror.writeNow()).toBe(true);
		expect(stored(ownKey(':live')!)!.fields.subject).toBe('Leaving now');
		// Already written: still held.
		expect(await c.mirror.writeNow()).toBe(true);

		c.draftState.value = 'scheduled';
		await settle();
		expect(await c.mirror.writeNow()).toBe(false);
		c.close();
	});

	it('writes the final snapshot when disposed right after an edit, without a timer flush', async () => {
		const c = openComposer();
		c.refs.subject.value = 'Last keystroke';
		c.close();
		await settle();
		expect(stored(ownKey(':live')!)!.fields.subject).toBe('Last keystroke');

		// The debounce died with the composer: nothing writes again later.
		driver.map.clear();
		await afterDebounce();
		expect(ownKeys()).toEqual([]);
	});

	it('leaves no copy when retired while a write is in flight', async () => {
		const c = openComposer();
		const held = driver.gate('set');
		c.refs.subject.value = 'About to be sent';
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		await held.reached;

		c.mirror.retire();
		held.release();
		await settle();
		expect(ownKeys()).toEqual([]);

		// Retired: later edits are not written.
		c.refs.subject.value = 'After send';
		await afterDebounce();
		expect(await c.mirror.writeNow()).toBe(false);
		expect(ownKeys()).toEqual([]);
		c.close();
		await settle();
		expect(ownKeys()).toEqual([]);
	});

	it('pauses writes while scheduled and flushes them once unscheduled', async () => {
		const c = openComposer();
		c.draftState.value = 'scheduled';
		await settle();
		c.refs.subject.value = 'Edited while scheduled';
		await afterDebounce();
		expect(ownKeys()).toEqual([]);

		c.draftState.value = 'draft';
		await settle();
		expect(stored(ownKey(':live')!)!.fields.subject).toBe('Edited while scheduled');
		c.close();
	});
});

// ── Offering ─────────────────────────────────────────────────────────────────

describe('offering copies other sessions left', () => {
	it("offers another session's copy for the same draft, newest first", async () => {
		seed(DRAFT, 'tabA', copyOf({ subject: 'Older' }, { savedAt: NOW - 120_000 }));
		const newer = seed(DRAFT, 'tabB', copyOf({ subject: 'Newer' }, { savedAt: NOW - 30_000 }));
		seed('draft-other', 'tabC', copyOf({ subject: 'Other draft' }, { savedAt: NOW - 1_000 }));

		const c = openComposer();
		await settle();
		expect(c.mirror.offer?.source).toMatchObject({ kind: 'v2', record: { key: newer } });
		expect(c.mirror.offer?.fields.subject).toBe('Newer');
		expect(c.mirror.offer?.base).toEqual(ROW);
		c.close();
	});

	it('deletes a copy whose fields equal the row', async () => {
		const key = seed(DRAFT, 'tabA', copyOf({}));
		const c = openComposer();
		await settle();
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(key)).toBe(false);
		c.close();
	});

	it('keeps a copy that was replaced between the scan and the conditional delete', async () => {
		const key = seed(DRAFT, 'tabA', copyOf({}));
		const replacement = copyOf({ subject: 'Typed in tab A meanwhile' }, { savedAt: NOW - 1_000 });
		driver.beforeDeleteIf = (k) => {
			if (k === key) driver.map.set(key, structuredClone(replacement));
		};

		const c = openComposer();
		await settle();
		expect(stored(key)).toEqual(replacement);

		await c.mirror.rescan();
		await settle();
		expect(c.mirror.offer?.fields.subject).toBe('Typed in tab A meanwhile');
		c.close();
	});

	it('skips a copy equal to the on-screen fields but keeps it', async () => {
		const onScreen = { ...ROW, subject: 'Merged back by the compose page' };
		const key = seed(DRAFT, 'tabA', copyOf(onScreen));
		const c = openComposer({ fields: onScreen });
		await settle();
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(key)).toBe(true);
		c.close();
	});

	it("does not offer a live session's copy (held Web Lock), and offers it once that session is gone", async () => {
		const locks = fakeLocks(['tabA']);
		setLocks(locks);
		const key = seed(DRAFT, 'tabA', copyOf({ subject: 'Still typing in tab A' }));

		const c = openComposer();
		await settle();
		expect(locks.request).toHaveBeenCalledTimes(1);
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(key)).toBe(true);

		locks.held.delete('owlat-mirror:tabA');
		await c.mirror.rescan();
		await settle();
		expect(c.mirror.offer?.fields.subject).toBe('Still typing in tab A');
		c.close();
	});

	it.each([
		['absent', () => undefined],
		[
			'rejecting',
			() => ({
				request: vi.fn(() => Promise.reject(new Error('denied'))),
				query: vi.fn(() => Promise.reject(new Error('denied'))),
			}),
		],
		[
			'throwing',
			() => ({
				request: vi.fn(() => {
					throw new Error('denied');
				}),
				query: vi.fn(() => {
					throw new Error('denied');
				}),
			}),
		],
	])('still offers copies when Web Locks are %s', async (_name, make) => {
		setLocks(make());
		seed(DRAFT, 'tabA', copyOf({ subject: 'Recovered' }));
		const c = openComposer();
		await settle();
		expect(c.mirror.offer?.fields.subject).toBe('Recovered');
		c.close();
	});

	it('offers a fresh composer only provisional copies (draftId null) of its own kind', async () => {
		const fresh = seed(
			provisionalDraftKey('tabA'),
			'tabA',
			copyOf({ subject: 'New message' }, { draftId: null, base: null })
		);
		const reply = seed(
			provisionalDraftKey('tabB'),
			'tabB',
			copyOf(
				{ subject: 'Re: hello' },
				{ draftId: null, base: null, inReplyTo: 'msg-1', savedAt: NOW - 1_000 }
			)
		);
		seed(DRAFT, 'tabC', copyOf({ subject: 'Has a row' }, { savedAt: NOW - 500 }));

		const a = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		await settle();
		expect(a.mirror.offer?.source).toMatchObject({ kind: 'v2', record: { key: fresh } });
		a.close();

		const b = openComposer({
			draftId: null,
			row: { status: 'unknown' },
			fields: BLANK,
			inReplyTo: 'msg-1',
		});
		await settle();
		expect(b.mirror.offer?.source).toMatchObject({ kind: 'v2', record: { key: reply } });
		expect(b.mirror.offer?.base).toBeNull();
		b.close();
	});

	describe('legacy v1 copies', () => {
		const legacyEntry = (subject: string) => ({
			fields: {
				toAddresses: ['ada@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				subject,
				bodyHtml: '<p>Old mirror</p>',
				composerMode: 'simple',
			},
			savedAt: NOW - 5_000,
			serverEditedAt: 0,
		});

		it('offers the draft key with no base', async () => {
			const key = `draft-mirror:${NS}:${DRAFT}`;
			driver.map.set(key, legacyEntry('From v1'));
			const c = openComposer();
			await settle();
			expect(c.mirror.offer?.source).toMatchObject({ kind: 'legacy', record: { key, id: DRAFT } });
			expect(c.mirror.offer?.base).toBeNull();
			expect(c.mirror.offer?.fields.subject).toBe('From v1');
			c.close();
		});

		it.each([
			['a fresh composition', undefined, 'new', 'new-reply:msg-1'],
			['a fresh reply', 'msg-1', 'new-reply:msg-1', 'new'],
		])('offers %s only its own provisional key', async (_name, inReplyTo, own, foreign) => {
			driver.map.set(`draft-mirror:${NS}:${own}`, legacyEntry('Mine'));
			driver.map.set(`draft-mirror:${NS}:${foreign}`, legacyEntry('Not mine'));
			const c = openComposer({
				draftId: null,
				row: { status: 'unknown' },
				fields: BLANK,
				inReplyTo,
			});
			await settle();
			expect(c.mirror.offer?.source).toMatchObject({ kind: 'legacy', record: { id: own } });
			expect(c.mirror.offer?.base).toBeNull();
			expect(driver.map.has(`draft-mirror:${NS}:${foreign}`)).toBe(true);
			c.close();
		});

		it('honours an old tombstone: entry and tombstone go, nothing is offered', async () => {
			driver.map.set(`draft-mirror:${NS}:${DRAFT}`, legacyEntry('Discarded in v1'));
			driver.map.set(`draft-mirror-dead:${NS}:${DRAFT}`, { at: NOW - 10_000 });
			const c = openComposer();
			await settle();
			expect(c.mirror.offer).toBeNull();
			expect(driver.map.has(`draft-mirror:${NS}:${DRAFT}`)).toBe(false);
			expect(driver.map.has(`draft-mirror-dead:${NS}:${DRAFT}`)).toBe(false);
			c.close();
		});
	});

	it('removes expired copies instead of offering them', async () => {
		const expired = seed(
			DRAFT,
			'tabA',
			copyOf({ subject: 'Ancient' }, { savedAt: NOW - 15 * DAY })
		);
		const c = openComposer();
		await settle();
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(expired)).toBe(false);
		c.close();
	});

	it('closes the offer when the row is confirmed missing', async () => {
		seed(DRAFT, 'tabA', copyOf({ subject: 'Recovered' }));
		const c = openComposer();
		await settle();
		expect(c.mirror.offer).not.toBeNull();

		c.latestRow.value = { status: 'missing' };
		await settle();
		expect(c.mirror.offer).toBeNull();
		c.close();
	});

	it('drops a scan whose draft id changed while it ran', async () => {
		const key = seed(DRAFT, 'tabA', copyOf({ subject: 'Recovered' }));
		const listing = driver.gate('keys');
		const c = openComposer();
		await listing.reached;

		c.draftId.value = 'draft-other';
		listing.release();
		await settle();
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(key)).toBe(true);
		c.close();
	});
});

// ── Restore ──────────────────────────────────────────────────────────────────

describe('restore', () => {
	async function withOffer(copy: MirrorCopy, options: OpenOptions = {}) {
		const source = seed(DRAFT, 'tabA', copy);
		const c = openComposer(options);
		await settle();
		expect(c.mirror.offer).not.toBeNull();
		return { c, source };
	}

	it('restores without confirmation when the base equals the row', async () => {
		const { c, source } = await withOffer(
			copyOf({ subject: 'Recovered', bodyHtml: '<p>Lost text</p>' })
		);

		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		await settle();
		expect(c.refs.subject.value).toBe('Recovered');
		expect(c.refs.bodyHtml.value).toBe('<p>Lost text</p>');
		expect(c.mirror.offer).toBeNull();
		expect(driver.map.has(source)).toBe(false);
		// The editor held the row: nothing to set aside.
		expect(ownKeys().some((k) => k.includes('pre-restore'))).toBe(false);
		// This session's live copy now holds the restored text.
		expect(stored(ownKey(':live')!)!.fields.subject).toBe('Recovered');
		c.close();
	});

	it.each([
		['differs from the row', { ...ROW, subject: 'An older save' }],
		['is unknown', null],
	])('asks for confirmation when the base %s', async (_name, base) => {
		const { c, source } = await withOffer(copyOf({ subject: 'Recovered' }, { base }));

		expect(await c.mirror.restore()).toEqual({ status: 'needs-confirmation' });
		expect(c.refs.subject.value).toBe(ROW.subject);
		expect(c.mirror.offer).not.toBeNull();
		expect(c.mirror.busy).toBe(false);
		expect(c.autosave.pause).toHaveBeenCalledTimes(1);
		expect(c.autosave.resume).toHaveBeenCalledTimes(1);
		expect(c.autosave.persistRestored).not.toHaveBeenCalled();
		expect(driver.map.has(source)).toBe(true);
		c.close();
	});

	it('asks again when confirmed against a row that has since changed', async () => {
		const { c } = await withOffer(copyOf({ subject: 'Recovered' }, { base: null }));
		expect(await c.mirror.restore()).toEqual({ status: 'needs-confirmation' });
		const confirmedAgainst = c.mirror.confirmationRow;
		expect(confirmedAgainst).toEqual(ROW);

		c.latestRow.value = loaded({ ...ROW, subject: 'Saved from another device' });
		await settle();
		expect(await c.mirror.restore({ row: confirmedAgainst })).toEqual({
			status: 'needs-confirmation',
		});
		expect(c.refs.subject.value).toBe(ROW.subject);

		expect(await c.mirror.restore({ row: c.mirror.confirmationRow })).toEqual({
			status: 'restored',
		});
		expect(c.refs.subject.value).toBe('Recovered');
		c.close();
	});

	it('sets the unsaved editor text aside as a pre-restore backup first', async () => {
		const { c } = await withOffer(copyOf({ subject: 'Recovered' }));
		c.refs.subject.value = 'Typed, not yet saved';

		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		const backupKey = ownKeys().find((k) => /:pre-restore\.[a-z0-9]+$/.test(k));
		expect(backupKey).toBeDefined();
		expect(backupKey!.startsWith(`draft-mirror:v2:${NS}:${DRAFT}:`)).toBe(true);
		expect(stored(backupKey!)).toMatchObject({
			fields: { ...ROW, subject: 'Typed, not yet saved' },
			base: ROW,
			draftId: DRAFT,
		});
		expect(c.refs.subject.value).toBe('Recovered');
		c.close();
	});

	it('aborts with backup-failed when the backup cannot be written, changing nothing', async () => {
		const { c, source } = await withOffer(copyOf({ subject: 'Recovered' }));
		c.refs.subject.value = 'Typed, not yet saved';
		driver.failSet = (key) => key.includes(':pre-restore.');

		expect(await c.mirror.restore()).toEqual({ status: 'aborted', reason: 'backup-failed' });
		expect(c.refs.subject.value).toBe('Typed, not yet saved');
		expect(c.mirror.offer?.fields.subject).toBe('Recovered');
		expect(driver.map.has(source)).toBe(true);
		expect(c.autosave.persistRestored).not.toHaveBeenCalled();
		expect(c.mirror.busy).toBe(false);
		expect(c.autosave.resume).toHaveBeenCalledTimes(1);
		c.close();
	});

	it('does not apply when the editor changed while the backup was being written', async () => {
		const { c, source } = await withOffer(copyOf({ subject: 'Recovered' }));
		c.refs.subject.value = 'Typed, not yet saved';
		const backup = driver.gate('set', (key) => key.includes(':pre-restore.'));

		const outcome = c.mirror.restore();
		await backup.reached;
		c.refs.subject.value = 'Typed during the backup';
		backup.release();

		expect(await outcome).not.toEqual({ status: 'restored' });
		expect(c.refs.subject.value).toBe('Typed during the backup');
		expect(c.autosave.persistRestored).not.toHaveBeenCalled();
		expect(driver.map.has(source)).toBe(true);
		expect(c.mirror.busy).toBe(false);
		c.close();
	});

	it('applies the restored fields without marking them touched', async () => {
		const { c } = await withOffer(
			copyOf({ toAddresses: ['bob@example.com'], subject: 'Recovered', bodyHtml: '<p>x</p>' })
		);
		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		expect(c.refs.toAddresses.value).toEqual(['bob@example.com']);
		expect(c.touched.list()).toEqual([]);
		c.close();
	});

	it('persists the restored blocks even in simple mode', async () => {
		const blocks = canonicalBlocks(BLOCKS);
		const { c } = await withOffer(
			copyOf({ subject: 'Recovered', bodyBlocks: blocks, composerMode: 'simple' })
		);

		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		expect(c.autosave.persistRestored).toHaveBeenCalledTimes(1);
		expect(c.autosave.persistRestored.mock.calls[0]![0]).toEqual({
			toAddresses: ROW.toAddresses,
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Recovered',
			bodyHtml: ROW.bodyHtml,
			bodyBlocks: blocks,
			composerMode: 'simple',
			followUpRemindAt: null,
		});
		expect(c.refs.bodyBlocks.value).toEqual(BLOCKS);
		c.close();
	});

	it('removes the source only after persistRestored succeeded', async () => {
		const { c, source } = await withOffer(copyOf({ subject: 'Recovered' }));
		const persisted = deferred<{ ok: boolean }>();
		c.autosave.persistRestored.mockImplementationOnce(() => persisted.promise);

		const outcome = c.mirror.restore();
		await settle();
		expect(c.refs.subject.value).toBe('Recovered');
		expect(driver.map.has(source)).toBe(true);

		persisted.resolve({ ok: true });
		expect(await outcome).toEqual({ status: 'restored' });
		await settle();
		expect(driver.map.has(source)).toBe(false);
		c.close();
	});

	it('keeps the source when persistRestored fails', async () => {
		const { c, source } = await withOffer(copyOf({ subject: 'Recovered' }));
		c.autosave.persistRestored.mockResolvedValueOnce({ ok: false });

		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		await settle();
		expect(driver.map.has(source)).toBe(true);
		// Equal to what is on screen now, so it is not offered again meanwhile.
		expect(c.mirror.offer).toBeNull();
		c.close();
	});

	it('pauses autosave and reports busy while restoring, then resumes', async () => {
		const { c } = await withOffer(copyOf({ subject: 'Recovered' }));
		const drained = deferred<void>();
		c.autosave.drain.mockImplementationOnce(() => drained.promise);

		const outcome = c.mirror.restore();
		await settle();
		expect(c.mirror.busy).toBe(true);
		expect(c.autosave.pause).toHaveBeenCalledTimes(1);
		expect(c.autosave.resume).not.toHaveBeenCalled();
		// A second Restore or Keep meanwhile is refused.
		expect(await c.mirror.restore()).toEqual({ status: 'aborted', reason: 'busy' });

		drained.resolve();
		expect(await outcome).toEqual({ status: 'restored' });
		expect(c.mirror.busy).toBe(false);
		expect(c.autosave.resume).toHaveBeenCalledTimes(1);
		expect(c.autosave.pause.mock.invocationCallOrder[0]!).toBeLessThan(
			c.autosave.drain.mock.invocationCallOrder[0]!
		);
		expect(c.autosave.drain.mock.invocationCallOrder[0]!).toBeLessThan(
			c.autosave.persistRestored.mock.invocationCallOrder[0]!
		);
		c.close();
	});

	it('creates the row first in a fresh composer, then waits for it to load', async () => {
		const source = seed(
			provisionalDraftKey('tabA'),
			'tabA',
			copyOf({ subject: 'Unsent new message' }, { draftId: null, base: null })
		);
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		await settle();
		expect(c.mirror.offer?.source).toMatchObject({ record: { key: source } });

		let settled = false;
		const first = c.mirror.restore().finally(() => (settled = true));
		await settle();
		expect(c.autosave.ensureDraft).toHaveBeenCalledTimes(1);
		expect(c.draftId.value).toBe('draft-new');
		expect(settled).toBe(false);

		c.latestRow.value = loaded(BLANK);
		// The copy predates the row, so it is checked like any other: it asks.
		expect(await first).toEqual({ status: 'needs-confirmation' });
		expect(c.refs.subject.value).toBe('');

		expect(await c.mirror.restore({ row: c.mirror.confirmationRow })).toEqual({
			status: 'restored',
		});
		expect(c.autosave.ensureDraft).toHaveBeenCalledTimes(1);
		expect(c.refs.subject.value).toBe('Unsent new message');
		await settle();
		expect(driver.map.has(source)).toBe(false);
		c.close();
	});

	it('keeps the source when a fresh composer cannot create its row', async () => {
		const source = seed(
			provisionalDraftKey('tabA'),
			'tabA',
			copyOf({ subject: 'Unsent new message' }, { draftId: null, base: null })
		);
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		await settle();
		c.autosave.ensureDraft.mockResolvedValueOnce(null as never);

		expect(await c.mirror.restore()).toEqual({ status: 'aborted', reason: 'unavailable' });
		expect(c.mirror.offer).not.toBeNull();
		expect(driver.map.has(source)).toBe(true);
		expect(c.mirror.busy).toBe(false);
		c.close();
	});

	it('creates two distinct backups for two Restores', async () => {
		seed(DRAFT, 'tabA', copyOf({ subject: 'Copy A' }, { savedAt: NOW - 10_000 }));
		seed(DRAFT, 'tabB', copyOf({ subject: 'Copy B' }, { savedAt: NOW - 20_000 }));
		const c = openComposer();
		await settle();
		c.refs.subject.value = 'Typed, not yet saved';

		expect(c.mirror.offer?.fields.subject).toBe('Copy A');
		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		await settle();
		expect(c.mirror.offer?.fields.subject).toBe('Copy B');
		expect(await c.mirror.restore()).toEqual({ status: 'restored' });
		await settle();

		const backups = ownKeys().filter((k) => k.includes(':pre-restore.'));
		expect(backups).toHaveLength(2);
		expect(new Set(backups).size).toBe(2);
		expect(backups.map((k) => stored(k)!.fields.subject).sort()).toEqual([
			'Copy A',
			'Typed, not yet saved',
		]);
		expect(c.refs.subject.value).toBe('Copy B');
		c.close();
	});
});

// ── Keep saved version ───────────────────────────────────────────────────────

describe('keep saved version', () => {
	it('removes the source and offers the next copy', async () => {
		const a = seed(DRAFT, 'tabA', copyOf({ subject: 'Copy A' }, { savedAt: NOW - 10_000 }));
		const b = seed(DRAFT, 'tabB', copyOf({ subject: 'Copy B' }, { savedAt: NOW - 20_000 }));
		const c = openComposer();
		await settle();
		expect(c.mirror.offer?.fields.subject).toBe('Copy A');

		await c.mirror.keep();
		await settle();
		expect(driver.map.has(a)).toBe(false);
		expect(c.refs.subject.value).toBe(ROW.subject);
		expect(c.mirror.offer?.source).toMatchObject({ record: { key: b } });
		c.close();
	});

	it('keeps a source that was replaced meanwhile, and offers its newer text', async () => {
		const a = seed(DRAFT, 'tabA', copyOf({ subject: 'Copy A' }));
		const c = openComposer();
		await settle();
		const replacement = copyOf({ subject: 'Copy A, typed on' }, { savedAt: NOW - 1_000 });
		driver.beforeDeleteIf = (key) => {
			if (key === a) driver.map.set(a, structuredClone(replacement));
		};

		await c.mirror.keep();
		await settle();
		expect(stored(a)).toEqual(replacement);
		expect(c.mirror.offer?.fields.subject).toBe('Copy A, typed on');
		c.close();
	});
});

// ── Migration onto the created row ───────────────────────────────────────────

describe('migration when the row is created', () => {
	async function freshWithLiveCopy() {
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		c.refs.subject.value = 'Before the row exists';
		await afterDebounce();
		const live = ownKey(':live')!;
		const session = sessionOf(live);
		expect(live).toBe(mirrorCopyKey(NS, provisionalDraftKey(session), session, 'live'));
		const backup = mirrorCopyKey(NS, provisionalDraftKey(session), session, 'pre-restore.bk1');
		driver.map.set(backup, copyOf({ subject: 'Set aside' }, { draftId: null, base: null }));
		return { c, session, live, backup };
	}

	it('moves every provisional slot to the draft key, deleting each source only after its destination committed', async () => {
		const { c, session, live, backup } = await freshWithLiveCopy();
		const destination = driver.gate('set', (key) => key.includes(':draft-7:'));

		c.created('draft-7');
		await destination.reached;
		expect(driver.map.has(live)).toBe(true);
		expect(driver.map.has(backup)).toBe(true);

		destination.release();
		await settle();
		expect(driver.map.has(live)).toBe(false);
		expect(driver.map.has(backup)).toBe(false);
		expect(stored(mirrorCopyKey(NS, 'draft-7', session, 'live'))).toMatchObject({
			draftId: 'draft-7',
			fields: { subject: 'Before the row exists' },
		});
		expect(stored(mirrorCopyKey(NS, 'draft-7', session, 'pre-restore.bk1'))).toMatchObject({
			draftId: 'draft-7',
			fields: { subject: 'Set aside' },
		});
		c.close();
	});

	it('keeps the provisional slots when the destination write fails', async () => {
		const { c, session, live, backup } = await freshWithLiveCopy();
		driver.failSet = (key) => key.includes(':draft-7:');

		c.created('draft-7');
		await settle();
		expect(driver.map.has(live)).toBe(true);
		expect(driver.map.has(backup)).toBe(true);
		expect(driver.map.has(mirrorCopyKey(NS, 'draft-7', session, 'live'))).toBe(false);
		c.close();
	});

	it('still runs after the composer was disposed', async () => {
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		c.refs.subject.value = 'Left before the row existed';
		c.close();
		await settle();
		const live = ownKey(':live')!;
		const session = sessionOf(live);

		c.created('draft-7');
		await settle();
		expect(driver.map.has(live)).toBe(false);
		expect(stored(mirrorCopyKey(NS, 'draft-7', session, 'live'))).toMatchObject({
			draftId: 'draft-7',
			fields: { subject: 'Left before the row existed' },
		});
	});

	// A live write queued before `onCreated` runs after `draftId` is set, so it
	// lands under the draft key; the migration behind it must not copy the
	// OLDER provisional copy over it.
	it('does not overwrite a newer live copy with the older provisional one', async () => {
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		const slowWrite = driver.gate('set');
		c.refs.subject.value = 'Older text';
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		await slowWrite.reached;
		c.refs.subject.value = 'Newer text';
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		c.created('draft-7');
		slowWrite.release();
		await settle();
		c.close();
		await settle();

		const live = ownKeys().filter((k) => k.endsWith(':live'));
		expect(live).toHaveLength(1);
		expect(stored(live[0]!)!.fields.subject).toBe('Newer text');
	});

	// A provisional write that commits after `draftId` changed records the key
	// it actually wrote, so retiring removes it (nothing of a sent or discarded
	// composition is offered to the next fresh composer).
	it('leaves no copy when retired after the row was created during an in-flight write', async () => {
		const c = openComposer({ draftId: null, row: { status: 'unknown' }, fields: BLANK });
		const slowWrite = driver.gate('set');
		c.refs.subject.value = 'Sent right away';
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		await slowWrite.reached;
		c.created('draft-7');
		c.mirror.retire();
		slowWrite.release();
		await settle();
		c.close();
		await settle();
		expect(ownKeys()).toEqual([]);
	});
});

// ── Retention ────────────────────────────────────────────────────────────────

describe('retention after a write', () => {
	it("never sweeps its own, a live session's or the offered copy, but expires and caps the rest", async () => {
		const locks = fakeLocks(['tabLive']);
		setLocks(locks);
		const liveSession = seed(
			'draft-x',
			'tabLive',
			copyOf({ subject: 'Live elsewhere' }, { savedAt: NOW - 20 * DAY })
		);
		const expired = seed(
			'draft-old',
			'tabOld',
			copyOf({ subject: 'Expired' }, { savedAt: NOW - 20 * DAY })
		);
		// Oldest of the unexpired ones: first in line for the cap, were it not offered.
		const offered = seed(
			DRAFT,
			'tabOffer',
			copyOf({ subject: 'Offered' }, { savedAt: NOW - 13 * DAY })
		);
		const capped: string[] = [];
		for (let i = 0; i < 32; i++) {
			capped.push(
				seed(
					`draft-c${i}`,
					`tabC${i}`,
					copyOf({ subject: `C${i}` }, { savedAt: NOW - 12 * DAY + i * 1_000 })
				)
			);
		}

		const c = openComposer();
		await settle();
		expect(c.mirror.offer?.source).toMatchObject({ record: { key: offered } });

		c.refs.bodyHtml.value = '<p>Own edit</p>';
		await afterDebounce();
		await settle();

		const own = ownKey(':live')!;
		expect(driver.map.has(own)).toBe(true);
		expect(driver.map.has(liveSession)).toBe(true);
		expect(driver.map.has(offered)).toBe(true);
		expect(driver.map.has(expired)).toBe(false);
		// 32 others beyond the cap of 30: the two oldest go.
		expect(capped.filter((key) => driver.map.has(key))).toEqual(capped.slice(2));
		c.close();
	});
});
