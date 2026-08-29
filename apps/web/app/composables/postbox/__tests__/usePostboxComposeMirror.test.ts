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
