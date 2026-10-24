/**
 * Which editor wrote a device copy, and whether it is still open
 * (`editorDraftWriters.ts`): a copy whose editor is open is left to it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createEditorDraftWriters } from '../editorDraftWriters';

/** A lock manager shared by "tabs": a held lock is a tab that is still open. */
function fakeLocks() {
	const held = new Set<string>();
	return {
		held,
		locks: {
			request: vi.fn(async (name: string) => {
				held.add(name);
				return await new Promise<never>(() => {});
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
		const isOpen = await writers.liveness();
		expect(isOpen(first.id)).toBe(false);
		expect(isOpen(second.id)).toBe(true);
	});

	it("leaves another open tab's copies to it, and recovers a closed tab's", async () => {
		const { locks, held } = fakeLocks();
		const tabA = createEditorDraftWriters('tab-a', locks);
		const tabB = createEditorDraftWriters('tab-b', locks);
		tabA.open();
		const writerB = tabB.open();
		await Promise.resolve();

		expect((await tabA.liveness())(writerB.id)).toBe(true);
		held.delete('owlat-editor-draft-tab:tab-b');
		expect((await tabA.liveness())(writerB.id)).toBe(false);
	});

	it('takes the lock once per tab', () => {
		const { locks } = fakeLocks();
		const writers = createEditorDraftWriters('tab-a', locks);
		writers.open();
		writers.open();
		expect(locks.request).toHaveBeenCalledOnce();
	});

	it("treats another tab's copy as left behind when the browser cannot tell", async () => {
		const writers = createEditorDraftWriters('tab-a', null);
		expect((await writers.liveness())('tab-b.1')).toBe(false);
	});
});
