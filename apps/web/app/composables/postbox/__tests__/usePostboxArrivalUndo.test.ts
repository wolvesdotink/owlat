// @vitest-environment happy-dom
/**
 * Undo toasts (read on arrival §4.4): the toast says what happened and offers
 * Undo; the result says honestly what did not come back (a reply reminder an
 * archive cleared, an unsubscribe request already sent, rows changed since).
 * The learned-digest notice shows once and is acknowledged when it leaves.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { usePostboxArrivalUndo } from '../usePostboxArrivalUndo';
import { usePostboxLearnedNotices } from '../usePostboxLearnedNotices';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const i18n = createTestI18n();
const undoRun = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: false }));
const ackRun = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: true }));
const showToast = vi.fn();
const notices = ref<unknown[] | null>(null);
const undoStatus = ref<Record<string, unknown> | null>(null);

beforeAll(() => {
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => ({
		run: opts.label() === 'Undo' ? undoRun : ackRun,
		isLoading: ref(false),
	}));
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		const value = args();
		const isStatus = typeof value === 'object' && value !== null && 'operationId' in value;
		return { data: isStatus ? undoStatus : notices, isLoading: ref(false) };
	});
});

beforeEach(() => {
	undoRun.mockReset();
	ackRun.mockClear();
	showToast.mockReset();
	notices.value = null;
	undoStatus.value = null;
});

function result(overrides: Record<string, unknown>) {
	return {
		ok: true,
		result: {
			status: 'undone',
			kind: 'fix',
			restored: 1,
			skipped: 0,
			hasMore: false,
			isNeedsReplyCleared: false,
			...overrides,
		},
	};
}

/** Show the toast, press its Undo, and return the toast the undo showed. */
async function pressUndo(): Promise<unknown[]> {
	const { offerUndo } = usePostboxArrivalUndo();
	offerUndo('Archived this conversation', 'op1' as never);
	const options = showToast.mock.calls[0]![2] as {
		action: { label: string; onAction: () => void };
	};
	expect(options.action.label).toBe('Undo');
	options.action.onAction();
	await flushPromises();
	expect(undoRun).toHaveBeenCalledWith({ operationId: 'op1' });
	return showToast.mock.calls[1]!;
}

describe('usePostboxArrivalUndo', () => {
	it('says a reply reminder the archive cleared did not come back', async () => {
		undoRun.mockResolvedValue(result({ isNeedsReplyCleared: true }));
		expect((await pressUndo())[0]).toBe('Moved back; reply reminders were not restored.');
	});

	it('says an unsubscribe request cannot be recalled', async () => {
		undoRun.mockResolvedValue(result({ kind: 'unsubscribe' }));
		expect((await pressUndo())[0]).toBe(
			'Undone The unsubscribe request was already sent and cannot be taken back.'
		);
	});

	it('says when only part could be undone, or nothing any more', async () => {
		undoRun.mockResolvedValue(result({ status: 'undo_partial', skipped: 1 }));
		expect(await pressUndo()).toEqual(['Undone, except what changed since', 'info']);
		showToast.mockReset();
		undoRun.mockResolvedValue(result({ status: 'expired' }));
		expect((await pressUndo())[0]).toBe('This can no longer be undone');
	});

	it('announces a multi-page undo once its last page ran, with every page counted', async () => {
		undoRun.mockResolvedValue(result({ restored: 100, hasMore: true }));
		const [first] = await pressUndo();
		expect(first).toBe('Undoing. The rest follows in a moment.');
		undoStatus.value = {
			status: 'undone',
			kind: 'fix',
			restored: 140,
			skipped: 0,
			isNeedsReplyCleared: false,
			isDone: false,
		};
		await nextTick();
		expect(showToast).toHaveBeenCalledTimes(2);
		// A later page skipped a row and found a cleared reminder.
		undoStatus.value = {
			...undoStatus.value,
			status: 'undo_partial',
			restored: 150,
			skipped: 1,
			isNeedsReplyCleared: true,
			isDone: true,
		};
		await nextTick();
		expect(showToast).toHaveBeenCalledTimes(3);
		expect(showToast.mock.calls[2]![0]).toBe('Moved back; reply reminders were not restored.');
	});

	it('shows a plain toast when there is no operation to undo', () => {
		const { offerUndo } = usePostboxArrivalUndo();
		offerUndo('It was already sorted that way', null);
		expect(showToast).toHaveBeenCalledWith('It was already sorted that way', 'success');
	});
});

describe('usePostboxLearnedNotices', () => {
	it('shows each notice once with Undo and acknowledges it when it leaves', async () => {
		usePostboxLearnedNotices(ref('mb1' as never));
		const notice = {
			operationId: 'op9',
			senderDigest: 'd',
			address: 'news@shop.example',
			learnedAt: 1,
		};
		notices.value = [{ ...notice, displayName: 'Shop' }];
		await nextTick();
		notices.value = [{ ...notice, displayName: 'Shop' }];
		await nextTick();
		expect(showToast).toHaveBeenCalledTimes(1);
		const [message, type, options] = showToast.mock.calls[0]! as [
			string,
			string,
			{ action: { label: string }; onDismiss: () => void },
		];
		expect(message).toBe('Mail from Shop now goes to your digest');
		expect(type).toBe('info');
		expect(options.action.label).toBe('Undo');
		options.onDismiss();
		expect(ackRun).toHaveBeenCalledWith({ operationId: 'op9' });
	});
});
