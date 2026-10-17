// @vitest-environment happy-dom
/**
 * "Why here?" (read on arrival §4.1): the popover answers from the arrival
 * record in plain copy (sender counters, what decided it, kind, read depth and
 * model calls, the reason keys), and its buttons open Fix, keep mail from the
 * sender where this one is ("Always here"), or go to the Senders page.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import PostboxWhyHerePopover from '../PostboxWhyHerePopover.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, { get: () => anyPath, apply: () => anyPath });
	return { api: anyPath };
});

const explanation = ref<Record<string, unknown> | null>(null);
const queriedWith = vi.fn();
const applyRun = vi.fn(async (_args: unknown): Promise<unknown> => ({ ok: false }));
const showToast = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (_query: unknown, args: () => unknown) => {
		queriedWith(args());
		return { data: explanation, isLoading: ref(false) };
	});
	vi.stubGlobal('useBackendOperation', () => ({ run: applyRun, isLoading: ref(false) }));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useEscapeToClose', () => {});
	vi.stubGlobal('useClickOutside', () => {});
});

beforeEach(() => {
	applyRun.mockReset();
	applyRun.mockResolvedValue({ ok: false });
	showToast.mockReset();
	queriedWith.mockReset();
	explanation.value = {
		threadId: 't1',
		messageId: 'm1',
		placement: 'updates',
		decidedBy: 'sender_status',
		sender: {
			address: 'news@bahn.example',
			displayName: 'Deutsche Bahn',
			status: 'digest',
			statusSource: 'learned',
			delivered: 14,
			opened: 3,
		},
		category: { label: 'notification', source: 'heuristic' },
		isReplyNeeded: false,
		depth: 'gist',
		modelCalls: 0,
		reasons: [{ key: 'arrival.reason.budget' }, { key: 'arrival.reason.notInThisBuild' }],
		isFenced: false,
	};
});

const buttonStub = { template: '<button type="button"><slot /></button>' };

function mountPopover() {
	const anchor = document.createElement('button');
	document.body.appendChild(anchor);
	return mount(PostboxWhyHerePopover, {
		props: {
			target: { mailboxId: 'mb1', threadId: 't1', placement: 'updates', anchor },
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				teleport: true,
				UiButton: buttonStub,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

describe('PostboxWhyHerePopover', () => {
	it('explains the placement in words, from the record', () => {
		const w = mountPopover();
		expect(queriedWith).toHaveBeenCalledWith({ threadId: 't1' });
		expect(w.text()).toContain('Why this is among your updates');
		expect(w.get('[data-testid="why-here-sender"]').text()).toBe(
			'Deutsche Bahn · 14 mails in about 90 days, you opened 3'
		);
		expect(w.get('[data-testid="why-here-decided"]').text()).toBe(
			'How you handle this sender: Digest, learned from mail you archived unread'
		);
		expect(w.text()).toContain('Notification · guessed from the headers');
		expect(w.get('[data-testid="why-here-read-as"]').text()).toBe('Gist · no model calls');
		// A reason key this build has no copy for is left out, never shown raw.
		expect(w.get('[data-testid="why-here-reasons"]').findAll('li')).toHaveLength(1);
		expectFullyLocalized(w);
	});

	it('"That\'s wrong" opens Fix for the record\'s message and closes', async () => {
		const w = mountPopover();
		await w.get('[data-testid="why-here-wrong"]').trigger('click');
		expect(w.emitted('fix')?.[0]).toEqual([
			{ messageId: 'm1', senderName: 'Deutsche Bahn', placement: 'updates' },
		]);
		expect(w.emitted('update:target')?.[0]).toEqual([null]);
	});

	it('"Always here" keeps mail from the sender where this one is', async () => {
		applyRun.mockResolvedValue({
			ok: true,
			result: {
				operationId: 'op1',
				archived: 0,
				resorted: 3,
				address: 'news@bahn.example',
				isNeedsReplyCleared: false,
				ruleDraftId: null,
			},
		});
		const w = mountPopover();
		await w.get('[data-testid="why-here-always"]').trigger('click');
		await flushPromises();
		expect(applyRun).toHaveBeenCalledWith({
			messageId: 'm1',
			destination: 'updates',
			scope: 'sender',
		});
		expect(showToast).toHaveBeenCalledWith(
			'Mail from Deutsche Bahn now shows in Updates',
			'success',
			expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
		);
		expect(w.emitted('update:target')?.[0]).toEqual([null]);
	});

	it('says so when there is nothing to explain, and still links to the Senders page', () => {
		explanation.value = null;
		const w = mountPopover();
		expect(w.find('[data-testid="why-here-empty"]').exists()).toBe(true);
		expect(w.find('[data-testid="why-here-wrong"]').exists()).toBe(false);
		expect(w.get('[data-testid="why-here-senders"]').attributes('href')).toBe(
			'/dashboard/postbox/senders'
		);
		expectFullyLocalized(w);
	});
});
