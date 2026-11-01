/**
 * Today's Upcoming band: mixed rows in the server's time order, the three
 * actions on a scheduled send (Send now arms the undo toast, Edit opens the
 * composer only after unscheduling, Cancel keeps the draft), failures that
 * change nothing, mailbox labels only with several inboxes, campaigns with no
 * inbox at all, and "more" that grows the page until the cap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		today: { upcoming: { list: 'upcoming.list' } },
		mail: {
			scheduledSends: { sendNow: 'sendNow' },
			drafts: { cancelScheduledSend: 'cancelScheduledSend' },
		},
	},
}));
const answerOpen = vi.fn();
vi.mock('~/composables/useAnswerMode', () => ({ useAnswerModeNav: () => ({ open: answerOpen }) }));
const arm = vi.fn();
vi.mock('~/composables/postbox/usePostboxUndoSend', () => ({
	usePostboxUndoSend: () => ({ arm }),
}));

const data = ref<unknown>(undefined);
const error = ref<Error | null>(null);
const refetch = vi.fn();
let argsOf: () => unknown = () => undefined;
const inboxes = ref<unknown[]>([{ mailboxId: 'mb1' }]);
const undoSendSeconds = ref(10);
const showToast = vi.fn();
const composeOpen = vi.fn();
const runs: Record<string, ReturnType<typeof vi.fn>> = {
	sendNow: vi.fn(),
	cancelScheduledSend: vi.fn(),
};

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useInboxes', () => ({ inboxes }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('usePostboxSettings', () => ({ undoSendSeconds }));
	vi.stubGlobal('usePostboxComposeNav', () => ({ open: composeOpen }));
	vi.stubGlobal('useOrganizationQuery', (_q: unknown, args: () => unknown) => {
		argsOf = args;
		return { data, error, isLoading: ref(false), refetch };
	});
	vi.stubGlobal('useBackendOperation', (fn: string) => ({
		run: (...a: unknown[]) => runs[fn]!(...a),
		isLoading: ref(false),
	}));
});

const { default: TodayUpcoming } = await import('../TodayUpcoming.vue');

// Wednesday 21 October 2026, 08:00 local time.
const NOW = new Date(2026, 9, 21, 8, 0).getTime();
const HOUR = 3_600_000;
const time = (at: number) => new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(at);

const send = {
	kind: 'scheduled_send',
	key: 'send:d1',
	at: NOW + HOUR,
	mailboxId: 'mb1',
	mailboxLabel: 'Ada',
	draftId: 'd1',
	subject: 'Re: Offer',
	firstRecipient: 'ines@example.com',
	recipientCount: 1,
	inReplyToMessageId: 'm0',
};
const snooze = {
	kind: 'snooze_return',
	key: 'snooze:t1',
	at: new Date(2026, 9, 23, 7, 0).getTime(),
	mailboxId: 'mb2',
	mailboxLabel: 'Support',
	threadId: 't1',
	messageId: 'm1',
	subject: 'Invoice 42',
	from: 'Lumen Labs',
	isUntilReply: false,
};
const campaign = {
	kind: 'campaign',
	key: 'campaign:c1',
	at: new Date(2026, 9, 27, 10, 0).getTime(),
	campaignId: 'c1',
	name: 'Autumn',
	timing: 'absolute',
	localTime: null,
	audienceName: 'Newsletter',
	recipients: { count: 12_400, countedAt: NOW - HOUR },
};

function mountBand() {
	return mount(TodayUpcoming, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
				UiButton: {
					props: ['disabled', 'loading'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
				UiQueryBoundary: {
					props: ['error', 'errorTitle'],
					emits: ['retry'],
					template:
						'<div data-testid="boundary">{{ errorTitle }}<button @click="$emit(\'retry\')">Retry</button></div>',
				},
			},
		},
	});
}

const rows = (w: ReturnType<typeof mountBand>) => w.findAll('li');
const button = (w: ReturnType<typeof mountBand>, name: string) =>
	w.findAll('button').find((b) => b.text() === name)!;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
	data.value = { items: [send, snooze, campaign], hasMore: false };
	error.value = null;
	inboxes.value = [{ mailboxId: 'mb1' }];
	undoSendSeconds.value = 10;
	for (const fn of [arm, answerOpen, composeOpen, showToast, refetch, ...Object.values(runs)]) {
		fn.mockReset();
	}
});
afterEach(() => {
	vi.useRealTimers();
});

describe('TodayUpcoming', () => {
	it('renders nothing while nothing is scheduled', () => {
		data.value = { items: [], hasMore: false };
		expect(mountBand().find('[data-testid="today-upcoming"]').exists()).toBe(false);
	});

	it('lists every kind in order with its when, words and link', () => {
		const w = mountBand();
		const [first, second, third] = rows(w);
		expect(first!.text()).toContain(time(send.at));
		expect(first!.text()).toContain('Re: Offer');
		expect(first!.text()).toContain('Sends to ines@example.com');
		expect(first!.find('a').exists()).toBe(false);
		expect(second!.text()).toContain(`Fri ${time(snooze.at)}`);
		expect(second!.text()).toContain('Returns from snooze · Lumen Labs');
		expect(second!.get('a').attributes('href')).toBe('/dashboard/postbox/snoozed/m1?mailbox=mb2');
		expect(third!.text()).toContain(`Tue ${time(campaign.at)}`);
		expect(third!.text()).toContain('Campaign Autumn');
		expect(third!.text()).toContain('to Newsletter · 12,400 recipients');
		expect(third!.get('a').attributes('href')).toBe('/dashboard/campaigns/c1/edit');
		// One inbox: nothing to tell apart.
		expect(w.text()).not.toContain('Support');
	});

	it('labels mail rows with their inbox when there are several', () => {
		inboxes.value = [{ mailboxId: 'mb1' }, { mailboxId: 'mb2' }];
		const [first, second] = rows(mountBand());
		expect(first!.text()).toContain('Ada');
		expect(second!.text()).toContain('Support');
	});

	it('shows campaigns with no inbox at all', () => {
		inboxes.value = [];
		data.value = { items: [campaign], hasMore: false };
		const w = mountBand();
		expect(rows(w)).toHaveLength(1);
		expect(w.text()).toContain('Campaign Autumn');
	});

	it('sends now with the undo window and arms the undo toast', async () => {
		runs['sendNow']!.mockResolvedValue({
			ok: true,
			result: { ok: true, undoToken: 'und_1', sendAt: NOW + 10_000 },
		});
		const w = mountBand();
		await button(w, 'Send now').trigger('click');
		await flushPromises();
		// The default window sends no delay: the server owns the number.
		expect(runs['sendNow']).toHaveBeenCalledWith({ draftId: 'd1', undoSendDelayMs: undefined });
		expect(arm).toHaveBeenCalledWith({
			undoToken: 'und_1',
			sendAt: NOW + 10_000,
			mailboxId: 'mb1',
			replyToMessageId: 'm0',
		});
	});

	it('says sent when undo is off, and says so when the send is no longer scheduled', async () => {
		undoSendSeconds.value = 0;
		runs['sendNow']!.mockResolvedValueOnce({
			ok: true,
			result: { ok: true, undoToken: 'und_1', sendAt: NOW },
		});
		const w = mountBand();
		await button(w, 'Send now').trigger('click');
		await flushPromises();
		expect(runs['sendNow']).toHaveBeenCalledWith({ draftId: 'd1', undoSendDelayMs: 0 });
		expect(arm).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('Sending now.', 'success');

		runs['sendNow']!.mockResolvedValueOnce({ ok: true, result: { ok: false } });
		await button(w, 'Send now').trigger('click');
		await flushPromises();
		expect(showToast).toHaveBeenLastCalledWith('That send is no longer scheduled.', 'info');
	});

	it('opens the reply in Answer mode only after unscheduling it', async () => {
		runs['cancelScheduledSend']!.mockResolvedValue({
			ok: true,
			result: { ok: true, draftId: 'd1' },
		});
		const w = mountBand();
		await button(w, 'Edit').trigger('click');
		await flushPromises();
		expect(runs['cancelScheduledSend']).toHaveBeenCalledWith({ draftId: 'd1' });
		expect(answerOpen).toHaveBeenCalledWith('m0', { draftId: 'd1' });
		expect(composeOpen).not.toHaveBeenCalled();
	});

	it('opens a new email on the compose page, and nothing when unscheduling failed', async () => {
		data.value = { items: [{ ...send, inReplyToMessageId: null }], hasMore: false };
		runs['cancelScheduledSend']!.mockResolvedValueOnce({ ok: false });
		const w = mountBand();
		await button(w, 'Edit').trigger('click');
		await flushPromises();
		expect(composeOpen).not.toHaveBeenCalled();

		runs['cancelScheduledSend']!.mockResolvedValueOnce({ ok: true, result: { ok: false } });
		await button(w, 'Edit').trigger('click');
		await flushPromises();
		expect(composeOpen).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenLastCalledWith('That send is no longer scheduled.', 'info');

		runs['cancelScheduledSend']!.mockResolvedValueOnce({
			ok: true,
			result: { ok: true, draftId: 'd1' },
		});
		await button(w, 'Edit').trigger('click');
		await flushPromises();
		expect(composeOpen).toHaveBeenCalledWith({ mailboxId: 'mb1', draftId: 'd1' });
	});

	it('cancels back to Drafts', async () => {
		runs['cancelScheduledSend']!.mockResolvedValue({
			ok: true,
			result: { ok: true, draftId: 'd1' },
		});
		const w = mountBand();
		await button(w, 'Cancel').trigger('click');
		await flushPromises();
		expect(showToast).toHaveBeenCalledWith('Unscheduled. It is back in Drafts.', 'success');
		expect(answerOpen).not.toHaveBeenCalled();
	});

	it('grows the page for more, and says so at the cap', async () => {
		data.value = { items: [send], hasMore: true };
		const w = mountBand();
		expect(argsOf()).toEqual({ limit: 8 });
		await button(w, 'Show more').trigger('click');
		expect(argsOf()).toEqual({ limit: 28 });
		await button(w, 'Show more').trigger('click');
		expect(argsOf()).toEqual({ limit: 48 });
		await button(w, 'Show more').trigger('click');
		expect(argsOf()).toEqual({ limit: 50 });
		expect(w.get('[data-testid="today-upcoming-more"]').text()).toBe(
			'More is scheduled than the Workbench lists.'
		);
	});

	it('shows a failed read with a retry', async () => {
		data.value = undefined;
		error.value = new Error('boom');
		const w = mountBand();
		expect(w.get('[data-testid="boundary"]').text()).toContain('Could not load what is coming up');
		await w.get('[data-testid="boundary"] button').trigger('click');
		expect(refetch).toHaveBeenCalled();
	});
});
