/**
 * The mail-cache controls in settings ("Clear local cache" and switching
 * "Store recent mail on this device" off) run over the real offline store and
 * the same driver the composer drafts use, so these cases prove that wiping
 * the cache never takes a person's unsent composer text with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type * as offlineStoreModule from '~/utils/postboxOfflineStore';
import { PostboxOfflineStore } from '~/utils/postboxOfflineStore';
import { ComposerDraftStore, composerDraftKey } from '~/utils/composerDraftStore';
import { composerDraftTestDriver } from '~/utils/__tests__/composerDraftTestDriver';

const driver = composerDraftTestDriver();
const offlineStore = new PostboxOfflineStore(driver);

vi.mock('~/utils/postboxOfflineStore', async (importOriginal) => {
	const actual = await importOriginal<typeof offlineStoreModule>();
	return {
		...actual,
		getPostboxOfflineStore: () => offlineStore,
		getOfflineKvDriver: () => driver,
	};
});

import { __resetPostboxOfflineCacheState, usePostboxOfflineCache } from '../usePostboxOfflineCache';

const NOW = Date.parse('2026-10-22T09:00:00Z');
const USER = 'user-a';
const MBX = 'mbx-test';
const DRAFT_KEY = composerDraftKey(USER, 'team-reply', 'th1');

/** A reload: a fresh store over what the device kept. */
async function draftsAfterReload() {
	const loaded = await new ComposerDraftStore(driver).load(USER, NOW, () => false);
	return loaded.map((draft) => draft.fields);
}

beforeEach(async () => {
	driver.map.clear();
	localStorage.clear();
	__resetPostboxOfflineCacheState();
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(false) }));
	vi.stubGlobal('useAuth', () => ({ user: ref({ id: USER }) }));
	await new ComposerDraftStore(driver).write(
		DRAFT_KEY,
		{ body: 'unsent reply', subject: 'Re: hi' },
		NOW
	);
	await offlineStore.saveThreads(`${USER}~${MBX}`, 'inbox', [{ _id: 't1' }]);
	await offlineStore.saveBody(`${USER}~${MBX}`, 'm1', '<p>cached</p>');
});

describe('usePostboxOfflineCache — composer drafts survive the cache controls', () => {
	it('"Clear local cache" wipes the mail cache and keeps the draft', async () => {
		const { clearCache } = usePostboxOfflineCache(MBX);

		await clearCache();

		expect([...driver.map.keys()]).toEqual([DRAFT_KEY]);
		expect(await draftsAfterReload()).toEqual([{ body: 'unsent reply', subject: 'Re: hi' }]);
	});

	it('switching the cache off wipes the mail cache and keeps the draft', async () => {
		const { setEnabled } = usePostboxOfflineCache(MBX);
		const wipe = vi.spyOn(offlineStore, 'clear');

		setEnabled(false);
		// The switch starts the wipe without waiting for it; wait for that wipe.
		expect(wipe).toHaveBeenCalledOnce();
		await wipe.mock.results[0]!.value;

		expect([...driver.map.keys()]).toEqual([DRAFT_KEY]);
		expect(await draftsAfterReload()).toEqual([{ body: 'unsent reply', subject: 'Re: hi' }]);
	});
});
