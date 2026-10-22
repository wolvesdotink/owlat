/**
 * "Why here?" (read on arrival §4.1): the popover answers from the arrival
 * record in plain copy (sender counters, what decided it, kind, read depth and
 * model calls, the reason keys), and its buttons open Fix, keep mail from the
 * sender where this one is ("Always here"), or go to the Senders page.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

function mountPopover(anchor = document.createElement('button')) {
	document.body.appendChild(anchor);
	return mount(PostboxWhyHerePopover, {
		attachTo: document.body,
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

	it('says when payment or legal wording kept it out of the digest (#1384)', () => {
		explanation.value = {
			...explanation.value,
			placement: 'today',
			decidedBy: 'exact_wording',
			depth: 'full',
			modelCalls: 1,
			reasons: [{ key: 'arrival.reason.exactWording' }],
		};
		const w = mountPopover();
		expect(w.text()).toContain('Why this is with everything else');
		expect(w.get('[data-testid="why-here-decided"]').text()).toBe(
			'It carries payment or legal wording, so it stays out of your digest and updates'
		);
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
			expect.objectContaining({ observedAction: expect.objectContaining({ label: 'Undo' }) })
		);
		expect(w.emitted('update:target')?.[0]).toEqual([null]);
	});

	it('takes focus when it opens and gives it back to the anchor when it closes', async () => {
		const anchor = document.createElement('button');
		const w = mountPopover(anchor);
		await flushPromises();
		expect(document.activeElement).toBe(w.get('[data-testid="why-here-popover"]').element);
		await w.setProps({ target: null });
		expect(document.activeElement).toBe(anchor);
		w.unmount();
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

	it('flips above a lower row when the window has no room below', async () => {
		const anchor = document.createElement('button');
		anchor.getBoundingClientRect = () =>
			({ top: 670, bottom: 710, left: 600, right: 640, width: 40, height: 40 }) as DOMRect;
		vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
		vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(320);
		const w = mountPopover(anchor);
		await flushPromises();
		const style = (w.get('[data-testid="why-here-popover"]').element as HTMLElement).style;
		expect(style.bottom).toBe('236px');
		expect(style.top).toBe('');
		expect(style.maxHeight).toBe('656px');
		vi.restoreAllMocks();
		w.unmount();
	});

	describe('when the window resizes or something scrolls', () => {
		let rect = { top: 670, bottom: 710, left: 600, right: 640 };
		let height = 900;
		function anchorAt() {
			const anchor = document.createElement('button');
			anchor.getBoundingClientRect = () =>
				({ ...rect, width: 40, height: 40, x: rect.left, y: rect.top }) as DOMRect;
			return anchor;
		}
		beforeEach(() => {
			rect = { top: 670, bottom: 710, left: 600, right: 640 };
			height = 900;
			vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => height);
			vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
			vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(320);
		});
		afterEach(() => vi.restoreAllMocks());

		it('re-places on resize: below once the taller window has room', async () => {
			const w = mountPopover(anchorAt());
			await flushPromises();
			const style = (w.get('[data-testid="why-here-popover"]').element as HTMLElement).style;
			expect(style.bottom).toBe('236px');
			height = 1400;
			window.dispatchEvent(new Event('resize'));
			expect(style.top).toBe('716px');
			expect(style.bottom).toBe('');
			w.unmount();
		});

		it('follows its anchor on a scroll in any container, kept inside the window', async () => {
			const w = mountPopover(anchorAt());
			await flushPromises();
			const style = (w.get('[data-testid="why-here-popover"]').element as HTMLElement).style;
			const column = document.createElement('div');
			document.body.appendChild(column);
			rect = { top: 200, bottom: 240, left: 600, right: 640 };
			column.dispatchEvent(new Event('scroll'));
			expect(style.top).toBe('246px');
			expect(w.emitted('update:target')).toBeUndefined();
			w.unmount();
		});

		it('closes once a scroll or resize takes the anchor out of the window', async () => {
			const scrolled = mountPopover(anchorAt());
			await flushPromises();
			rect = { top: -200, bottom: -160, left: 600, right: 640 };
			document.body.dispatchEvent(new Event('scroll'));
			expect(scrolled.emitted('update:target')?.[0]).toEqual([null]);
			scrolled.unmount();

			rect = { top: 670, bottom: 710, left: 600, right: 640 };
			const resized = mountPopover(anchorAt());
			await flushPromises();
			height = 600;
			window.dispatchEvent(new Event('resize'));
			expect(resized.emitted('update:target')?.[0]).toEqual([null]);
			resized.unmount();
		});

		it('ignores scrolling inside its own panel', async () => {
			const w = mountPopover(anchorAt());
			await flushPromises();
			rect = { top: -200, bottom: -160, left: 600, right: 640 };
			w.get('[data-testid="why-here-popover"]').element.dispatchEvent(new Event('scroll'));
			expect(w.emitted('update:target')).toBeUndefined();
			w.unmount();
		});
	});
});
