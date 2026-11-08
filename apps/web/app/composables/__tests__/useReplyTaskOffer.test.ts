/**
 * Which replies are watched for a confirmed send, and the offer once one is:
 * one open task by name with Mark done, several by count with Review, none
 * with nothing. A scheduled send, one queued offline and a reply with no draft
 * or thread are never watched. The offer never marks a task done on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';

const setStatus = vi.hoisted(() => vi.fn(async () => true));
vi.mock('~/composables/useTaskActions', () => ({ useTaskActions: () => ({ setStatus }) }));

import {
	clearReplyTaskHolds,
	holdMailReplyOffer,
	holdTeamReplyOffer,
	releaseReplyTaskHold,
	useReplyTaskHolds,
	useReplyTaskOffer,
} from '../useReplyTaskOffer';

const { t, locale } = createTestI18n().global;

let showToast: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
let navigateTo: ReturnType<typeof vi.fn>;
let tasks: Array<{ _id: string; title: string; status: string }>;

beforeEach(() => {
	clearReplyTaskHolds();
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

const keys = () => useReplyTaskHolds().value.map((h) => h.key);
const mailIds = { draftId: 'd1', threadMessageId: 'm1', mailThreadId: 'thread_1' };

function lastToast() {
	const [message, , options] = showToast.mock.lastCall as [
		string,
		string,
		{ action: { label: string; onAction: () => void } },
	];
	return { message, action: options.action };
}

describe('reply holds', () => {
	it('watches a reply that leaves on its own, once, until released', () => {
		holdMailReplyOffer({ scheduled: false, queuedOffline: false }, mailIds);
		holdMailReplyOffer({ scheduled: false, queuedOffline: false }, mailIds);
		expect(useReplyTaskHolds().value).toEqual([
			{
				kind: 'mail',
				key: 'mail:d1',
				target: { mailThreadId: 'thread_1' },
				draftId: 'd1',
				threadMessageId: 'm1',
			},
		]);
		releaseReplyTaskHold('mail:d1');
		expect(keys()).toEqual([]);
	});

	it('never watches a scheduled send, one queued offline, or a reply without draft or thread', () => {
		holdMailReplyOffer({ scheduled: true, queuedOffline: false }, mailIds);
		holdMailReplyOffer({ scheduled: false, queuedOffline: true }, mailIds);
		holdMailReplyOffer({ scheduled: false, queuedOffline: false }, { ...mailIds, draftId: null });
		holdMailReplyOffer(
			{ scheduled: false, queuedOffline: false },
			{ ...mailIds, mailThreadId: undefined }
		);
		expect(keys()).toEqual([]);
	});

	it('watches a team approve per window, and a follow-up by its id', () => {
		holdTeamReplyOffer({ kind: 'reply', messageId: 'in_1', sendAt: 5 }, 'conv_1' as never);
		holdTeamReplyOffer({ kind: 'reply', messageId: 'in_1' }, 'conv_1' as never);
		holdTeamReplyOffer({ kind: 'followUp', followUpId: 'fu_1', sendAt: 9 }, 'conv_1' as never);
		expect(keys()).toEqual(['approve:in_1:5', 'approve:in_1:now', 'followUp:fu_1']);
		expect(useReplyTaskHolds().value[2]).toMatchObject({
			kind: 'followUp',
			followUpId: 'fu_1',
			target: { conversationThreadId: 'conv_1' },
		});
	});
});

describe('useReplyTaskOffer', () => {
	it('names the one open task, and only its action marks it done', async () => {
		await useReplyTaskOffer().offer({ mailThreadId: 'thread_1' as never });
		expect(query).toHaveBeenCalledExactlyOnceWith(expect.anything(), { mailThreadId: 'thread_1' });
		const toast = lastToast();
		expect(toast.message).toBe('Sent. Mark “Send the signed contract” done?');
		expect(toast.action.label).toBe('Mark done');
		expect(setStatus).not.toHaveBeenCalled();
		toast.action.onAction();
		expect(setStatus).toHaveBeenCalledExactlyOnceWith(tasks[0], 'done');
	});

	it('counts several open tasks, and Review opens the first on the Tasks page', async () => {
		tasks = [
			{ _id: 'task_a', title: 'A', status: 'open' },
			{ _id: 'task_b', title: 'B', status: 'open' },
			{ _id: 'task_c', title: 'C', status: 'open' },
			{ _id: 'task_d', title: 'D', status: 'done' },
		];
		await useReplyTaskOffer().offer({ conversationThreadId: 'conv_1' as never });
		const toast = lastToast();
		expect(toast.message).toBe('Sent. 3 tasks from this conversation are still open.');
		expect(toast.action.label).toBe('Review');
		toast.action.onAction();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/tasks?task=task_a');
	});

	it('stays quiet when nothing from the conversation is open', async () => {
		tasks = [{ _id: 'task_1', title: 'Done already', status: 'done' }];
		await useReplyTaskOffer().offer({ mailThreadId: 'thread_1' as never });
		expect(showToast).not.toHaveBeenCalled();
	});
});
