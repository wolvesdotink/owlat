/**
 * Which editor wrote a device copy, and whether it is still open
 * (`editorDraftWriters.ts`): a copy whose editor is open is left to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEditorDraftWriters } from '../editorDraftWriters';

/** A lock manager shared by "tabs": a lock is held until its callback settles. */
function fakeLocks() {
	const held = new Set<string>();
	return {
		held,
		locks: {
			request: vi.fn(async (name: string, callback: () => unknown) => {
				// Granted a moment after the request, as the browser does.
				await Promise.resolve();
				held.add(name);
				try {
					return await callback();
				} finally {
					held.delete(name);
				}
			}),
			query: vi.fn(async () => ({ held: [...held].map((name) => ({ name })), pending: [] })),
		} as unknown as Pick<LockManager, 'request' | 'query'>,
	};
}

describe('editorDraftWriters', () => {
	it('knows which editors in this tab are open', async () => {
		const writers = createEditorDraftWriters('tab-a', null);
		const first = writers.open();
		const second = writers.open();
		expect(first.id).toBe('tab-a.1');
		expect(second.id).toBe('tab-a.2');

		first.close();
		const liveness = await writers.liveness();
		expect(liveness(first.id)).toBe('closed');
		expect(liveness(second.id)).toBe('open');
	});

	it("leaves another tab's open editor its copy, and recovers a closed tab's", async () => {
		const { locks, held } = fakeLocks();
		const tabA = createEditorDraftWriters('tab-a', locks);
		const tabB = createEditorDraftWriters('tab-b', locks);
		tabA.open();
		const writerB = tabB.open();
		await Promise.resolve();

		expect((await tabA.liveness())(writerB.id)).toBe('open');
		// The tab went away, and its locks with it.
		held.clear();
		expect((await tabA.liveness())(writerB.id)).toBe('closed');
	});

	it('recovers the copy of an editor another tab closed while that tab stays open', async () => {
		const { locks } = fakeLocks();
		const tabA = createEditorDraftWriters('tab-a', locks);
		const tabB = createEditorDraftWriters('tab-b', locks);
		const closed = tabA.open();
		const open = tabA.open();
		await Promise.resolve();
		closed.close();
		await Promise.resolve();
		await Promise.resolve();

		const liveness = await tabB.liveness();
		expect(liveness(closed.id)).toBe('closed');
		expect(liveness(open.id)).toBe('open');
	});

	it('releases the lock of an editor closed before the lock was granted', async () => {
		const { locks, held } = fakeLocks();
		const writers = createEditorDraftWriters('tab-a', locks);
		writers.open().close();
		await Promise.resolve();
		await Promise.resolve();
		expect(held.size).toBe(0);
	});

	it("calls another tab's editor unknown when the browser cannot tell, never closed", async () => {
		const writers = createEditorDraftWriters('tab-a', null);
		expect((await writers.liveness())('tab-b.1')).toBe('unknown');
		// Asking for the locks failing is no proof either.
		const { locks } = fakeLocks();
		locks.query = vi.fn(async () => {
			throw new Error('SecurityError');
		}) as never;
		const failing = createEditorDraftWriters('tab-a', locks);
		expect((await failing.liveness())('tab-b.1')).toBe('unknown');
		// This tab's own editors are known either way.
		const own = failing.open();
		expect((await failing.liveness())(own.id)).toBe('open');
	});
});
