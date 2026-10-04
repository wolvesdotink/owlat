/**
 * Draft-mirror lifecycle across compositions (plan idea 7).
 *
 * The pure reconcile and the store's key handling are covered in
 * `utils/__tests__/postboxDraftMirror.test.ts`. What these tests pin is the
 * part only the wiring can get wrong: that retiring ONE composition never
 * disables crash recovery for the next one, because the keys are shared.
 *
 *   - a fresh compose mirrors under `new`, so discarding a blank compose must
 *     leave the next blank compose mirroring normally;
 *   - refusing a restore offer supersedes that one entry, not the draft — the
 *     composer is still open, and what the user types next is unsaved work
 *     again, so a crash after the refusal must still have something to offer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';
import type { EditorBlock } from '@owlat/email-builder';
import type { DraftMirrorEntry } from '~/utils/postboxDraftMirror';
import { PostboxDraftMirrorStore } from '~/utils/postboxDraftMirrorStore';
import type { OfflineKvDriver } from '~/utils/postboxOfflineStore';
import {
	usePostboxComposeMirror,
	DRAFT_MIRROR_DEBOUNCE_MS,
	type ComposeMirrorSources,
} from '../usePostboxComposeMirror';

/** In-memory stand-in for IndexedDB, shared by every store in one test. */
function memoryDriver(): OfflineKvDriver {
	const map = new Map<string, unknown>();
	return {
		async get<T>(key: string) {
			return map.get(key) as T | undefined;
		},
		async set(key, value) {
			// structuredClone, like IndexedDB: a reactive proxy is refused, which a
			// JSON round trip would quietly accept.
			map.set(key, structuredClone(value));
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

let store: PostboxDraftMirrorStore;
vi.mock('~/utils/postboxDraftMirrorStore', async (importActual) => {
	const actual = await importActual<typeof import('~/utils/postboxDraftMirrorStore')>();
	return { ...actual, getPostboxDraftMirrorStore: () => store };
});

const MAILBOX = 'mbx-1';

interface Composer {
	mirror: ReturnType<typeof usePostboxComposeMirror>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	toAddresses: Ref<string[]>;
	lastSavedAt: Ref<number | null>;
	close: () => void;
}

/** Open one composer's mirror inside its own scope, like a mounted composer. */
function openComposer(over: Partial<ComposeMirrorSources> = {}): Composer {
	const subject = ref('');
	const bodyHtml = ref('');
	const toAddresses = ref<string[]>([]);
	const lastSavedAt = ref<number | null>(null);
	const sources: ComposeMirrorSources = {
		mailboxId: MAILBOX as never,
		draftId: ref(null),
		lastSavedAt,
		draftState: ref('draft'),
		toAddresses,
		ccAddresses: ref([]),
		bccAddresses: ref([]),
		subject,
		bodyHtml,
		bodyBlocks: ref([] as EditorBlock[]),
		composerMode: ref('simple'),
		followUpRemindAt: ref(null),
		ready: () => true,
		...over,
	};
	const scope = effectScope();
	const mirror = scope.run(() => usePostboxComposeMirror(sources))!;
	return { mirror, subject, bodyHtml, toAddresses, lastSavedAt, close: () => scope.stop() };
}

/** Let the field watcher fire, the debounce elapse and the store write land. */
async function settle() {
	await nextTick();
	await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
	await vi.advanceTimersByTimeAsync(0);
}

/**
 * Read a mirror straight off the device. Deliberately NOT `store.load`, which
 * consumes a tombstone — that consumption belongs to the next composer, and an
 * assertion must not perform it for them.
 */
async function peek(key: string): Promise<DraftMirrorEntry | null> {
	return (await driver.get<DraftMirrorEntry>(`draft-mirror:${MAILBOX}:${key}`)) ?? null;
}

let driver: OfflineKvDriver;

beforeEach(() => {
	vi.useFakeTimers();
	driver = memoryDriver();
	store = new PostboxDraftMirrorStore(driver);
});

describe('usePostboxComposeMirror — retiring one composition', () => {
	it('lets the NEXT fresh compose mirror after one was discarded', async () => {
		const first = openComposer();
		await vi.advanceTimersByTimeAsync(0); // its reconcile
		first.toAddresses.value = ['ines@northwind.studio'];
		first.subject.value = 'Invoice 4471';
		await settle();
		expect(await peek('new')).not.toBeNull();

		// Deliberate throw-away: the mirror must not survive it…
		first.mirror.retire();
		await vi.advanceTimersByTimeAsync(0);
		first.close();
		expect(await peek('new')).toBeNull();

		// …but the very next blank compose shares that provisional key, and is a
		// different message, so it gets the same protection as any other.
		const second = openComposer();
		await vi.advanceTimersByTimeAsync(0);
		second.subject.value = 'Re-quote for the ceiling';
		await settle();
		expect(await peek('new')).toMatchObject({
			fields: { subject: 'Re-quote for the ceiling' },
		});
	});

	it('does not resurrect a discarded compose from a write already debounced', async () => {
		const composer = openComposer();
		await vi.advanceTimersByTimeAsync(0);
		composer.subject.value = 'Half-typed';
		await nextTick();
		// Discard lands before the 400ms debounce elapses.
		composer.mirror.retire();
		await settle();
		expect(await peek('new')).toBeNull();
	});

	it('keeps mirroring a draft whose restore offer was refused', async () => {
		const seedDraftId = 'draft-1';
		await store.save(MAILBOX, seedDraftId, {
			fields: {
				toAddresses: ['ines@northwind.studio'],
				ccAddresses: [],
				bccAddresses: [],
				subject: 'Invoice 4471',
				bodyHtml: '<p>the paragraph the crash ate</p>',
				composerMode: 'simple',
			},
			savedAt: 1_000,
			serverEditedAt: 500,
		});

		const composer = openComposer({ seedDraftId: seedDraftId as never });
		// Hydration: the server row lands, which is also the reconcile trigger.
		composer.toAddresses.value = ['ines@northwind.studio'];
		composer.subject.value = 'Invoice 4471';
		composer.bodyHtml.value = '<p>Hi Ines,</p>';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(composer.mirror.restorable).not.toBeNull();

		// "Keep the saved version" — that one entry is superseded…
		composer.mirror.dismiss();
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(seedDraftId)).toBeNull();

		// …and the user carries on typing in the still-open composer.
		composer.bodyHtml.value = '<p>Hi Ines, the invoice is attached.</p>';
		await settle();
		const kept = await peek(seedDraftId);
		expect(kept?.fields.bodyHtml).toBe('<p>Hi Ines, the invoice is attached.</p>');

		// A crash here (a second composer opening the same row) still has it.
		composer.close();
		const reopened = openComposer({ seedDraftId: seedDraftId as never });
		reopened.toAddresses.value = ['ines@northwind.studio'];
		reopened.subject.value = 'Invoice 4471';
		reopened.bodyHtml.value = '<p>Hi Ines,</p>';
		reopened.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(reopened.mirror.restorable).toMatchObject({
			fields: { bodyHtml: '<p>Hi Ines, the invoice is attached.</p>' },
		});
	});
});

describe('usePostboxComposeMirror — closing before the server has the text', () => {
	const ROW = 'draft-9';

	it('writes a still-debounced edit when the composer closes, not drops it', async () => {
		const composer = openComposer({ seedDraftId: ROW as never });
		composer.subject.value = 'Saved subject';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);

		composer.subject.value = 'Typed in the last 400ms';
		await nextTick();
		composer.close();
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(ROW)).toMatchObject({
			fields: { subject: 'Typed in the last 400ms' },
			serverEditedAt: 500,
		});
	});

	it('writes on demand, for a host leaving before its text is confirmed saved', async () => {
		const composer = openComposer({ seedDraftId: ROW as never });
		composer.subject.value = 'Edited offline';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);

		composer.mirror.writeNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(ROW)).toMatchObject({ fields: { subject: 'Edited offline' } });
	});

	it('offers the text back when the save on leaving never landed', async () => {
		const first = openComposer({ seedDraftId: ROW as never });
		first.subject.value = 'Old';
		first.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		first.subject.value = 'Newer, never saved';
		first.mirror.writeNow();
		await vi.advanceTimersByTimeAsync(0);
		first.close();

		// The row is as it was: same edit time, older text.
		const again = openComposer({ seedDraftId: ROW as never });
		again.subject.value = 'Old';
		again.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(again.mirror.restorable?.fields.subject).toBe('Newer, never saved');
	});

	it('stands aside when a save landed after it was written', async () => {
		const first = openComposer({ seedDraftId: ROW as never });
		first.subject.value = 'Old';
		first.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		first.subject.value = 'Newer';
		first.mirror.writeNow();
		await vi.advanceTimersByTimeAsync(0);
		first.close();

		// The save on leaving landed: the row is newer than the mirror.
		const again = openComposer({ seedDraftId: ROW as never });
		again.subject.value = 'Newer';
		again.lastSavedAt.value = 900;
		await vi.advanceTimersByTimeAsync(0);
		expect(again.mirror.restorable).toBeNull();
	});
});

describe('usePostboxComposeMirror — only real text, never over a recovery copy', () => {
	const ROW = 'draft-11';
	const savedEntry = (subject: string, serverEditedAt = 500) =>
		store.save(MAILBOX, ROW, {
			fields: {
				toAddresses: ['ines@northwind.studio'],
				ccAddresses: [],
				bccAddresses: [],
				subject,
				bodyHtml: '<p>Unsaved body</p>',
				composerMode: 'simple',
			},
			savedAt: 1_000,
			serverEditedAt,
		});

	it('writes nothing before the row has loaded: its fields are placeholders', async () => {
		const composer = openComposer({ seedDraftId: ROW as never, ready: () => false });
		composer.subject.value = 'Typed while loading';
		await nextTick();
		composer.mirror.writeNow();
		composer.close();
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		expect(await peek(ROW)).toBeNull();
	});

	it('keeps an open restore offer’s entry when the composer closes untouched', async () => {
		await savedEntry('Unsaved subject');
		const composer = openComposer({ seedDraftId: ROW as never });
		// Loading the row moves the fields (and arms a write of the older text).
		composer.toAddresses.value = ['ines@northwind.studio'];
		composer.subject.value = 'Saved subject';
		composer.bodyHtml.value = '<p>Saved body</p>';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(composer.mirror.restorable).not.toBeNull();

		composer.close();
		await vi.advanceTimersByTimeAsync(DRAFT_MIRROR_DEBOUNCE_MS);
		expect((await peek(ROW))?.fields.subject).toBe('Unsaved subject');
	});

	it('keeps an open offer’s entry when a save of other text lands', async () => {
		await savedEntry('Unsaved subject');
		const composer = openComposer({ seedDraftId: ROW as never });
		composer.subject.value = 'Saved subject';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(composer.mirror.restorable).not.toBeNull();

		composer.lastSavedAt.value = 800; // some save, not of the offered text
		await vi.advanceTimersByTimeAsync(0);
		expect((await peek(ROW))?.fields.subject).toBe('Unsaved subject');
	});

	it('moves an open offer to the new row time when a save only re-sent the row', async () => {
		// The composer re-saves a loaded row; that moves the row's edit time but
		// not its text. A reopen must still offer the recovery copy.
		await savedEntry('Unsaved subject');
		const loadedRow = {
			toAddresses: ['ines@northwind.studio'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Saved subject',
			bodyHtml: '<p>Saved body</p>',
			composerMode: 'simple' as const,
			followUpRemindAt: null,
		};
		const composer = openComposer({ seedDraftId: ROW as never, serverSnapshot: ref(loadedRow) });
		composer.toAddresses.value = ['ines@northwind.studio'];
		composer.subject.value = 'Saved subject';
		composer.bodyHtml.value = '<p>Saved body</p>';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		composer.lastSavedAt.value = 800;
		await vi.advanceTimersByTimeAsync(0);
		composer.close();
		expect(await peek(ROW)).toMatchObject({
			fields: { subject: 'Unsaved subject' },
			serverEditedAt: 800,
		});

		const again = openComposer({ seedDraftId: ROW as never, serverSnapshot: ref(loadedRow) });
		again.toAddresses.value = ['ines@northwind.studio'];
		again.subject.value = 'Saved subject';
		again.bodyHtml.value = '<p>Saved body</p>';
		again.lastSavedAt.value = 800;
		await vi.advanceTimersByTimeAsync(0);
		expect(again.mirror.restorable?.fields.subject).toBe('Unsaved subject');
	});

	it('leaves an open offer behind a save of new edits', async () => {
		await savedEntry('Unsaved subject');
		const loadedRow = {
			toAddresses: ['ines@northwind.studio'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Saved subject',
			bodyHtml: '<p>Saved body</p>',
			composerMode: 'simple' as const,
			followUpRemindAt: null,
		};
		const composer = openComposer({ seedDraftId: ROW as never, serverSnapshot: ref(loadedRow) });
		composer.toAddresses.value = ['ines@northwind.studio'];
		composer.subject.value = 'Saved subject';
		composer.bodyHtml.value = '<p>Saved body</p>';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		composer.subject.value = 'Typed instead of restoring';
		composer.lastSavedAt.value = 800;
		await vi.advanceTimersByTimeAsync(0);
		expect(await peek(ROW)).toMatchObject({ serverEditedAt: 500 });
	});

	it('reconciles against the row as loaded, not the editor’s merged fields', async () => {
		// Offline undo: the editor keeps the seeded text, which the mirror also
		// holds; the server row still has the old text. Nothing was saved, so
		// the mirror must survive, not be dropped as "already on the server".
		await savedEntry('Edited offline');
		const serverSnapshot = ref({
			toAddresses: ['ines@northwind.studio'],
			ccAddresses: [],
			bccAddresses: [],
			subject: 'Old',
			bodyHtml: '<p>Old body</p>',
			composerMode: 'simple' as const,
			followUpRemindAt: null,
		});
		const composer = openComposer({ seedDraftId: ROW as never, serverSnapshot });
		composer.toAddresses.value = ['ines@northwind.studio'];
		composer.subject.value = 'Edited offline';
		composer.bodyHtml.value = '<p>Unsaved body</p>';
		composer.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(composer.mirror.restorable?.fields.subject).toBe('Edited offline');
	});

	it('records a new row’s creation time as its baseline until a save lands', async () => {
		const draftId = ref<string | null>(null);
		const rowCreatedAt = ref<number | null>(null);
		const composer = openComposer({ draftId: draftId as never, rowCreatedAt });
		await vi.advanceTimersByTimeAsync(0); // fresh compose reconciles at once
		draftId.value = ROW;
		rowCreatedAt.value = 900;
		composer.subject.value = 'First save failed';
		await settle();
		expect(await peek(ROW)).toMatchObject({ serverEditedAt: 900 });
	});

	it('mirrors and restores the follow-up reminder', async () => {
		const followUpRemindAt = ref<number | null>(null);
		const first = openComposer({ seedDraftId: ROW as never, followUpRemindAt });
		first.subject.value = 'Saved subject';
		first.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		followUpRemindAt.value = 7_000;
		await settle();
		first.close();

		const reminder = ref<number | null>(null);
		const again = openComposer({ seedDraftId: ROW as never, followUpRemindAt: reminder });
		again.subject.value = 'Saved subject';
		again.lastSavedAt.value = 500;
		await vi.advanceTimersByTimeAsync(0);
		again.mirror.restore();
		expect(reminder.value).toBe(7_000);
	});
});
