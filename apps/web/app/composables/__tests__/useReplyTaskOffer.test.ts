/**
 * The offer to finish a conversation's tasks waits for the reply to leave:
 * nothing while its undo window is open, the offer when it closes, nothing at
 * all after an Undo, for a scheduled send or for one queued offline. It never
 * marks a task done on its own: only the toast's action does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';

const setStatus = vi.hoisted(() => vi.fn(async () => true));
vi.mock('~/composables/useTaskActions', () => ({ useTaskActions: () => ({ setStatus }) }));

import { approveHoldToken, cancelReplyTaskOffer, useReplyTaskOffer } from '../useReplyTaskOffer';

const { t, locale } = createTestI18n().global;
const T0 = Date.UTC(2026, 10, 8, 9, 0);

let showToast: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let navigateTo: ReturnType<typeof vi.fn>;
let tasks: Array<{ _id: string; title: string; status: string }>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
	showToast = vi.fn();
	navigateTo = vi.fn();
	tasks = [{ _id: 'task_1', title: 'Send the signed contract', status: 'open' }];
	query = vi.fn(async () => tasks);
	setStatus.mockClear();
	vi.stubGlobal('useI18n', () => ({ t, locale }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useConvex', () => ({ query }));
	vi.stubGlobal('navigateTo', navigateTo);
});

afterEach(() => {
	vi.useRealTimers();
});

function lastToast() {
	const [message, type, options] = showToast.mock.lastCall as [
		string,
		string,
		{ action: { label: string; onAction: () => void } },
	];
	return { message, type, action: options.action };
}

const mailSend = (
	undoToken: string,
	over: { scheduled?: boolean; queuedOffline?: boolean } = {}
) => ({
	scheduled: over.scheduled ?? false,
	queuedOffline: over.queuedOffline ?? false,
	receipt: { undoToken, sendAt: T0 + 10_000 },
});

describe('useReplyTaskOffer', () => {
	it('offers the one open task once the undo window has closed, and only then', async () => {
		useReplyTaskOffer().offerAfterMailReply(mailSend('u1'), 'thread_1');
		await vi.advanceTimersByTimeAsync(9_999);
		expect(query).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(query).toHaveBeenCalledExactlyOnceWith(expect.anything(), { mailThreadId: 'thread_1' });
		const toast = lastToast();
		expect(toast.message).toBe('Sent. Mark “Send the signed contract” done?');
		expect(toast.action.label).toBe('Mark done');
		expect(setStatus).not.toHaveBeenCalled();

		toast.action.onAction();
		expect(setStatus).toHaveBeenCalledExactlyOnceWith(tasks[0], 'done');
	});

	it('offers nothing for a reply taken back in its window', async () => {
		useReplyTaskOffer().offerAfterMailReply(mailSend('u2'), 'thread_1');
		cancelReplyTaskOffer('mail', 'u2');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(query).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalled();
	});

	it('never offers for a scheduled send, one queued offline, or a reply with no thread', async () => {
		const offer = useReplyTaskOffer();
		offer.offerAfterMailReply(mailSend('u3', { scheduled: true }), 'thread_1');
		offer.offerAfterMailReply(mailSend('outbox:ns:1', { queuedOffline: true }), 'thread_1');
		offer.offerAfterMailReply(mailSend('u4'), undefined);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(query).not.toHaveBeenCalled();
	});

	it('counts several open tasks, and Review opens the first on the Tasks page', async () => {
		tasks = [
			{ _id: 'task_a', title: 'A', status: 'open' },
			{ _id: 'task_b', title: 'B', status: 'open' },
			{ _id: 'task_c', title: 'C', status: 'open' },
			{ _id: 'task_d', title: 'D', status: 'done' },
		];
		useReplyTaskOffer().offerAfterMailReply(mailSend('u5'), 'thread_1');
		await vi.advanceTimersByTimeAsync(10_000);
		const toast = lastToast();
		expect(toast.message).toBe('Sent. 3 tasks from this conversation are still open.');
		expect(toast.action.label).toBe('Review');
		toast.action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/tasks?task=task_a');
	});

	it('stays quiet when nothing from the conversation is open', async () => {
		tasks = [{ _id: 'task_1', title: 'Done already', status: 'done' }];
		await useReplyTaskOffer().offer({ mailThreadId: 'thread_1' as never });
		expect(query).toHaveBeenCalledOnce();
		expect(showToast).not.toHaveBeenCalled();
	});

	it('holds a team approve until its window closes, and an Undo of it drops the offer', async () => {
		const offer = useReplyTaskOffer();
		offer.offerAfterTeamReply(
			{ kind: 'reply', messageId: 'in_1', sendAt: T0 + 5_000 },
			'conv_1' as never
		);
		cancelReplyTaskOffer('approve', approveHoldToken('in_1', T0 + 5_000));
		offer.offerAfterTeamReply(
			{ kind: 'followUp', followUpId: 'fu_1', sendAt: T0 + 5_000 },
			'conv_1' as never
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(query).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
			conversationThreadId: 'conv_1',
		});
	});

	it('offers a team reply with no undo window right away', async () => {
		useReplyTaskOffer().offerAfterTeamReply(
			{ kind: 'reply', messageId: 'in_2' },
			'conv_1' as never
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(query).toHaveBeenCalledOnce();
		expect(lastToast().message).toBe('Sent. Mark “Send the signed contract” done?');
	});
});
