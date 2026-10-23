/**
 * Whether the page may reload without losing anything: every owner of unsaved
 * work answers, and only composer drafts are waited for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { ComposerDraftBook } from '~/composables/useComposerDrafts';

const book = vi.hoisted(() => ({
	unstored: false,
	idle: (() => Promise.resolve()) as () => Promise<void>,
}));

vi.mock('~/composables/useComposerDrafts', () => ({
	useComposerDrafts: () =>
		({
			hasUnstoredDrafts: () => book.unstored,
			idle: () => book.idle(),
		}) as unknown as ComposerDraftBook,
}));

import {
	holdPendingWork,
	registerUnsavedWorkProbe,
	resetPendingOperations,
	trackPendingOperation,
} from '../pendingOperations';
import { registerReloadBlocker } from '../reloadBlockers';
import { DRAFT_SETTLE_TIMEOUT_MS, canReloadNow, settleForReload } from '../reloadSafety';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

beforeEach(() => {
	book.unstored = false;
	book.idle = () => Promise.resolve();
});
afterEach(() => {
	resetPendingOperations();
	vi.useRealTimers();
});

describe('settleForReload', () => {
	it('allows a reload when nothing is pending, dirty or unstored', async () => {
		expect(await settleForReload()).toBe(true);
	});

	it('refuses while a write, a hold or a probe holds unsaved work', async () => {
		const settle = trackPendingOperation(() => 'Save');
		expect(await settleForReload()).toBe(false);
		settle(true);

		const release = holdPendingWork();
		expect(await settleForReload()).toBe(false);
		release(true);

		const unregister = registerUnsavedWorkProbe(() => true);
		expect(await settleForReload()).toBe(false);
		unregister();

		expect(await settleForReload()).toBe(true);
	});

	it('refuses while a registered blocker reports unsaved edits', async () => {
		let dirty = true;
		const unregister = registerReloadBlocker(() => dirty);
		try {
			expect(await settleForReload()).toBe(false);
			dirty = false;
			expect(await settleForReload()).toBe(true);
			dirty = true;
		} finally {
			unregister();
		}
		expect(await settleForReload()).toBe(true);
	});

	it('waits for drafts to reach the device, then allows the reload', async () => {
		const writes = deferred();
		book.unstored = true;
		book.idle = () => writes.promise;
		let answer: boolean | undefined;
		void settleForReload().then((value) => (answer = value));
		await flushPromises();
		expect(answer).toBeUndefined();

		book.unstored = false;
		writes.resolve();
		await flushPromises();
		expect(answer).toBe(true);
	});

	it('refuses when a draft did not commit, or an edit arrived while waiting', async () => {
		book.unstored = true;
		expect(await settleForReload()).toBe(false);

		book.unstored = false;
		const writes = deferred();
		book.idle = () => writes.promise;
		let dirty = false;
		const unregister = registerReloadBlocker(() => dirty);
		try {
			const answer = settleForReload();
			dirty = true;
			writes.resolve();
			expect(await answer).toBe(false);
		} finally {
			unregister();
		}
	});

	it('gives up when the drafts do not settle in time', async () => {
		vi.useFakeTimers();
		book.idle = () => new Promise<void>(() => {});
		const answer = settleForReload();
		await vi.advanceTimersByTimeAsync(DRAFT_SETTLE_TIMEOUT_MS);
		expect(await answer).toBe(false);
	});
});

describe('canReloadNow', () => {
	it('answers at once, counting a draft still on its way to the device as lost', () => {
		expect(canReloadNow()).toBe(true);

		book.unstored = true;
		book.idle = () => new Promise<void>(() => {});
		expect(canReloadNow()).toBe(false);
		book.unstored = false;

		const unregister = registerReloadBlocker(() => true);
		expect(canReloadNow()).toBe(false);
		unregister();

		const release = holdPendingWork();
		expect(canReloadNow()).toBe(false);
		release(true);

		expect(canReloadNow()).toBe(true);
	});
});
