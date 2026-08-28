// @vitest-environment happy-dom
/**
 * The folder rail's cold-start bridge (plan idea 49).
 *
 * Cached thread rows without a cached rail is half an offline app: the list
 * comes back and there is nothing to navigate it with. These cases pin the
 * same contract the thread bridge has — cached rows while pending, live rows
 * the instant they land, and no leak across mailboxes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';

import { usePostboxOfflineFolders } from '../usePostboxOfflineFolders';

type Folder = { _id: string; name: string };

const cached: Record<string, Folder[]> = {
	mbxA: [
		{ _id: 'f1', name: 'Inbox' },
		{ _id: 'f2', name: 'Legal hold' },
	],
	mbxB: [{ _id: 'f9', name: 'B inbox' }],
};

const persistFolders = vi.fn(async () => {});
const loadFolders = vi.fn();
const loadFoldersMeta = vi.fn(async () => ({ savedAt: 1_700_000_000_000 }));

/** The namespace the stubbed cache was constructed with, as the real one does. */
let boundMailbox: Ref<string | null>;

beforeEach(() => {
	persistFolders.mockClear();
	loadFoldersMeta.mockClear();
	loadFolders.mockReset();
	loadFolders.mockImplementation(async () => cached[boundMailbox.value ?? ''] ?? []);
	vi.stubGlobal('usePostboxOfflineCache', (mailboxId: Ref<string | null>) => {
		boundMailbox = mailboxId;
		return { loadFolders, loadFoldersMeta, persistFolders };
	});
});

function setup(options: { mailboxId?: string | null; loading?: boolean } = {}) {
	// `?? 'mbxA'` would swallow the explicit null this suite needs to test.
	const mailboxId = ref<string | null>('mailboxId' in options ? options.mailboxId! : 'mbxA');
	const liveFolders = ref<Folder[]>([]);
	const isLoading = ref(options.loading ?? true);
	const bridge = usePostboxOfflineFolders<Folder>({ mailboxId, liveFolders, isLoading });
	return { mailboxId, liveFolders, isLoading, ...bridge };
}

describe('usePostboxOfflineFolders', () => {
	it('renders the cached rail while the query is pending, then the live rows', async () => {
		const rail = setup();
		await nextTick();
		await nextTick();

		expect(rail.rows.value.map((f) => f.name)).toEqual(['Inbox', 'Legal hold']);
		expect(rail.showingCached.value).toBe(true);
		expect(rail.cachedAt.value).toBe(1_700_000_000_000);

		rail.liveFolders.value = [{ _id: 'f1', name: 'Inbox' }];
		rail.isLoading.value = false;
		await nextTick();

		// Live always wins — including dropping a folder deleted on another device.
		expect(rail.rows.value.map((f) => f.name)).toEqual(['Inbox']);
		expect(rail.showingCached.value).toBe(false);
	});

	it('falls back to the live rows when nothing is cached yet', async () => {
		const rail = setup();
		loadFolders.mockImplementation(async () => []);
		rail.liveFolders.value = [{ _id: 'f3', name: 'Fresh' }];
		await nextTick();

		expect(rail.rows.value.map((f) => f.name)).toEqual(['Fresh']);
		expect(rail.showingCached.value).toBe(false);
	});

	it('persists the rail once the live query settles', async () => {
		const rail = setup();
		rail.liveFolders.value = [{ _id: 'f1', name: 'Inbox' }];
		rail.isLoading.value = false;
		await nextTick();

		expect(persistFolders).toHaveBeenCalledWith([{ _id: 'f1', name: 'Inbox' }]);
	});

	it('never overwrites a good cached rail with an empty result', async () => {
		const rail = setup();
		rail.isLoading.value = false;
		await nextTick();

		// Every mailbox has at least an inbox, so `[]` means "not really loaded".
		expect(persistFolders).not.toHaveBeenCalled();
	});

	it('reloads on a mailbox switch and never shows the other account meanwhile', async () => {
		const rail = setup();
		await nextTick();
		await nextTick();
		expect(rail.rows.value.map((f) => f.name)).toEqual(['Inbox', 'Legal hold']);

		rail.mailboxId.value = 'mbxB';
		await nextTick();
		// The previous account's folder names are gone before the await resolves.
		expect(rail.rows.value).toEqual([]);

		await nextTick();
		await nextTick();
		expect(rail.rows.value.map((f) => f.name)).toEqual(['B inbox']);
	});

	it('drops a cache read that lands after the mailbox changed again', async () => {
		let release: ((value: Folder[]) => void) | null = null;
		loadFolders.mockImplementationOnce(
			() =>
				new Promise<Folder[]>((resolve) => {
					release = resolve;
				})
		);
		const rail = setup();

		rail.mailboxId.value = 'mbxB';
		await nextTick();
		// mbxA's slow read finally answers — it must not repaint mbxB's rail.
		release?.([{ _id: 'f2', name: 'Legal hold' }]);
		await nextTick();
		await nextTick();

		expect(rail.rows.value.map((f) => f.name)).toEqual(['B inbox']);
	});

	it('reads nothing at all without a mailbox', async () => {
		const rail = setup({ mailboxId: null });
		await nextTick();

		expect(loadFolders).not.toHaveBeenCalled();
		expect(rail.rows.value).toEqual([]);
	});
});
