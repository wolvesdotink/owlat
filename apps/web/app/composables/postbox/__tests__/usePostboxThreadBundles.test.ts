/**
 * usePostboxThreadBundles — the join and the two verbs behind the bundled view:
 *   - categories come off the THREAD, so the fold reads them through the
 *     listThreads feed indexed by thread id (the fold itself is unit-tested in
 *     utils/__tests__/postboxBundles.test.ts),
 *   - archiving a bundle is one call plus one undo entry, not one per row, and
 *   - unsubscribing is never fired without an explicit confirmation.
 *
 * The Convex query/operation composables are stubbed as globals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { usePostboxThreadBundles } from '../usePostboxThreadBundles';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const threadRows = ref<Array<{ _id: string; category?: { label: string } }>>([]);
const runSpy = vi.fn(async (): Promise<unknown> => ({ ok: true, result: {} }));
const registerMoveBack = vi.fn();

function message(id: string, threadId: string, overrides: Record<string, unknown> = {}) {
	return {
		_id: id,
		threadId,
		fromAddress: `${id}@example.com`,
		flagSeen: true,
		...overrides,
	};
}

beforeEach(() => {
	threadRows.value = [];
	runSpy.mockClear();
	registerMoveBack.mockClear();
	vi.stubGlobal('useConvexQuery', () => ({
		data: ref({ threads: threadRows.value }),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack }));
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
});

function setup(messages: ReturnType<typeof message>[]) {
	return usePostboxThreadBundles({
		mailboxId: ref('mailbox-1' as never),
		messages: ref(messages) as never,
		enabled: ref(true),
	});
}

describe('usePostboxThreadBundles feed', () => {
	it('folds a run using the category joined from the thread', () => {
		threadRows.value = [
			{ _id: 't1', category: { label: 'newsletter' } },
			{ _id: 't2', category: { label: 'newsletter' } },
		];
		const { entries } = setup([message('a', 't1'), message('b', 't2')]);
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]).toMatchObject({ kind: 'bundle', category: 'newsletter', count: 2 });
	});

	it('leaves rows alone when their threads carry no category yet', () => {
		threadRows.value = [{ _id: 't1' }, { _id: 't2' }];
		const { entries } = setup([message('a', 't1'), message('b', 't2')]);
		expect(entries.value.every((entry) => entry.kind === 'message')).toBe(true);
	});

	it('starts every bundle collapsed', () => {
		threadRows.value = [
			{ _id: 't1', category: { label: 'receipt' } },
			{ _id: 't2', category: { label: 'receipt' } },
		];
		const { entries, expanded, toggle } = setup([message('a', 't1'), message('b', 't2')]);
		const bundleId = (entries.value[0] as { id: string }).id;
		expect(expanded.value[bundleId]).toBeUndefined();
		toggle(bundleId);
		expect(expanded.value[bundleId]).toBe(true);
	});
});

describe('archiveBundle', () => {
	it('archives every id in one call and registers ONE undo entry', async () => {
		runSpy.mockResolvedValueOnce({
			ok: true,
			result: { moved: [{ messageId: 'a', sourceFolderId: 'f1' }] },
		});
		const { archiveBundle } = setup([]);
		await expect(archiveBundle(['a', 'b', 'c'])).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith({ messageIds: ['a', 'b', 'c'] });
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
	});

	it('does nothing for an empty bundle', async () => {
		const { archiveBundle } = setup([]);
		await expect(archiveBundle([])).resolves.toBe(false);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('registers no undo when the archive failed', async () => {
		runSpy.mockResolvedValueOnce({ ok: false });
		const { archiveBundle } = setup([]);
		await expect(archiveBundle(['a'])).resolves.toBe(false);
		expect(registerMoveBack).not.toHaveBeenCalled();
	});
});

describe('unsubscribeBundle', () => {
	it('asks first — these are state-changing requests to third parties', async () => {
		const confirm = vi.fn(() => false);
		vi.stubGlobal('window', { confirm } as never);
		const { unsubscribeBundle } = setup([]);
		await expect(unsubscribeBundle(['a@example.com'], ['m1'])).resolves.toBe(false);
		expect(confirm).toHaveBeenCalled();
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('sends the senders and the bundle ids once confirmed', async () => {
		vi.stubGlobal('window', { confirm: () => true } as never);
		const { unsubscribeBundle } = setup([]);
		await expect(unsubscribeBundle(['a@example.com'], ['m1', 'm2'])).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mailbox-1',
			senderEmails: ['a@example.com'],
			messageIds: ['m1', 'm2'],
		});
	});

	it('never prompts when the bundle has no one-click sender', async () => {
		const confirm = vi.fn(() => true);
		vi.stubGlobal('window', { confirm } as never);
		const { unsubscribeBundle } = setup([]);
		await expect(unsubscribeBundle([], ['m1'])).resolves.toBe(false);
		expect(confirm).not.toHaveBeenCalled();
	});
});
