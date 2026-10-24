/**
 * usePostboxThreadBundles — the feed and the two verbs behind the bundled view:
 *   - the fold reads the category the server attached to each row, with no
 *     second thread subscription (the fold itself is unit-tested in
 *     utils/__tests__/postboxBundles.test.ts),
 *   - archiving a bundle is one call plus one undo entry, not one per row, and
 *   - unsubscribing is never fired without an explicit confirmation.
 *
 * The Convex query/operation composables are stubbed as globals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, ref } from 'vue';
import { installConfirm, type ConfirmDriver } from '~/__tests__/confirm';
import { usePostboxThreadBundles } from '../usePostboxThreadBundles';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const runSpy = vi.fn(async (): Promise<unknown> => ({ ok: true, result: {} }));
const registerMoveBack = vi.fn();

const convexQuery = vi.fn();

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
	convexQuery.mockClear();
	runSpy.mockClear();
	registerMoveBack.mockClear();
	vi.stubGlobal('useConvexQuery', convexQuery);
	vi.stubGlobal('useBackendOperation', () => ({ run: runSpy, isLoading: ref(false) }));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack }));
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
});

function setup(messages: ReturnType<typeof message>[]) {
	return usePostboxThreadBundles({
		mailboxId: ref('mailbox-1' as never),
		messages: ref(messages) as never,
	});
}

describe('usePostboxThreadBundles feed', () => {
	it('folds a run using the category the server attached to each row', () => {
		const { entries } = setup([
			message('a', 't1', { category: 'newsletter' }),
			message('b', 't2', { category: 'newsletter' }),
		]);
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]).toMatchObject({ kind: 'bundle', category: 'newsletter', count: 2 });
	});

	it('opens no second thread subscription to recover the category', () => {
		const { entries } = setup([message('a', 't1', { category: 'newsletter' })]);
		void entries.value;
		expect(convexQuery).not.toHaveBeenCalled();
	});

	it('leaves rows alone when their threads carry no category yet', () => {
		const { entries } = setup([message('a', 't1'), message('b', 't2')]);
		expect(entries.value.every((entry) => entry.kind === 'message')).toBe(true);
	});

	it('starts every bundle collapsed', () => {
		const { entries, expanded, toggle } = setup([
			message('a', 't1', { category: 'receipt' }),
			message('b', 't2', { category: 'receipt' }),
		]);
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
	let confirmDriver: ConfirmDriver;
	beforeEach(() => {
		confirmDriver = installConfirm();
	});
	afterEach(() => confirmDriver.dispose());

	it('asks first — these are state-changing requests to third parties', async () => {
		const { unsubscribeBundle } = setup([]);
		const answer = unsubscribeBundle(['a@example.com', 'b@example.com'], ['m1']);
		expect(confirmDriver.pending[0]).toMatchObject({
			title: 'shared.postbox.usePostboxThreadBundles.unsubscribeConfirm',
			body: 'shared.postbox.usePostboxThreadBundles.unsubscribeConfirmBody',
			confirmText: 'components.postbox.postboxThreadBundleList.unsubscribe',
			variant: 'warning',
		});
		expect(runSpy).not.toHaveBeenCalled();
		confirmDriver.answer(false);
		await expect(answer).resolves.toBe(false);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('sends the senders and the bundle ids once confirmed', async () => {
		const { unsubscribeBundle } = setup([]);
		const answer = unsubscribeBundle(['a@example.com'], ['m1', 'm2']);
		await Promise.resolve();
		expect(runSpy).not.toHaveBeenCalled();
		confirmDriver.answer(true);
		await expect(answer).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith({
			mailboxId: 'mailbox-1',
			senderEmails: ['a@example.com'],
			messageIds: ['m1', 'm2'],
		});
	});

	it('acts on the mailbox the question was asked in, not one switched to meanwhile', async () => {
		const mailboxId = ref('mailbox-1' as never);
		const { unsubscribeBundle } = usePostboxThreadBundles({
			mailboxId,
			messages: ref([]) as never,
		});
		const answer = unsubscribeBundle(['a@example.com'], ['m1']);
		mailboxId.value = 'mailbox-2' as never;
		confirmDriver.answer(true);
		await expect(answer).resolves.toBe(true);
		expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'mailbox-1' }));
	});

	it('sends nothing when the list that asked is torn down with the question open', async () => {
		const scope = effectScope();
		const { unsubscribeBundle } = scope.run(() => setup([]))!;
		const answer = unsubscribeBundle(['a@example.com'], ['m1']);
		scope.stop();
		await expect(answer).resolves.toBe(false);
		expect(confirmDriver.pending).toEqual([]);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it('never prompts when the bundle has no one-click sender', async () => {
		const { unsubscribeBundle } = setup([]);
		await expect(unsubscribeBundle([], ['m1'])).resolves.toBe(false);
		expect(confirmDriver.pending).toEqual([]);
	});
});
