/**
 * PostboxTodayReaderOverlay — the Today view's centered reader pane:
 *   - j/k (and arrows) emit `open` for the adjacent row WITHOUT closing
 *   - Esc and a scrim click emit `close`; unmounting restores the opener's focus
 *   - keys stay inert in text-entry targets and while another dialog is open
 *   - single-key triage is forwarded to the reader over the
 *     `owlat:postbox-reader-action` bridge while focus is inside the pane
 *   - the hosted reader's `advance` maps to `open` (id) / `close` (null).
 *
 * The reader itself is stubbed (it is Convex-backed and covered elsewhere);
 * these tests pin the overlay's keyboard/focus contract.
 */
import { describe, it, expect, vi, afterEach, beforeAll, onTestFinished } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineAsyncComponent, nextTick } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

import PostboxTodayReaderOverlay from '../PostboxTodayReaderOverlay.vue';

const readerStub = {
	props: {
		message: { type: Object, required: true },
		advanceIds: { type: Array, default: () => [] },
		folderRole: { type: String, default: undefined },
		advanceInPlace: { type: Boolean, default: false },
	},
	emits: ['advance'],
	template: '<div class="reader-stub" :data-id="message._id" />',
};

function msg(id: string) {
	return {
		_id: id,
		mailboxId: 'mbx-1',
		fromAddress: 'a@example.com',
		toAddresses: [],
		ccAddresses: [],
		subject: 'Subject',
		receivedAt: Date.now(),
		hasAttachments: false,
		attachments: [],
	};
}

// The pane's accessible name flows through vue-i18n now; `useI18n` is a Nuxt
// auto-import, so it has to exist as a global.
beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

let wrapper: VueWrapper | undefined;
afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
});

const overlayStubs = {
	UiTooltip: { template: '<span><slot /></span>' },
	UiButton: { template: '<button type="button"><slot /></button>' },
	PostboxReaderSkeleton: { template: '<div class="skeleton-stub" />' },
	UiQueryBoundary: {
		emits: ['retry'],
		template: '<button class="retry-stub" @click="$emit(\'retry\')" />',
	},
	PostboxMessageNotFound: { template: '<div class="gone-stub"><slot name="action" /></div>' },
};

function mountOverlay(id = 'm2', advanceIds = ['m1', 'm2', 'm3']) {
	wrapper = mount(PostboxTodayReaderOverlay, {
		attachTo: document.body,
		props: { message: msg(id) as never, advanceIds },
		global: {
			plugins: [createTestI18n()],
			components: { LazyPostboxThreadReader: readerStub },
			stubs: overlayStubs,
		},
	});
	return wrapper;
}

function pressOnWindow(key: string) {
	window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('PostboxTodayReaderOverlay', () => {
	it('j/k swap to the adjacent row without closing', async () => {
		const w = mountOverlay();
		pressOnWindow('j');
		pressOnWindow('k');
		expect(w.emitted('open')).toEqual([['m3'], ['m1']]);
		expect(w.emitted('close')).toBeUndefined();
		expect(w.find('.reader-stub').exists()).toBe(true);
	});

	it('swaps the thread in the same tick, with no leave to wait for', async () => {
		// An out-in <Transition> would mount the next thread only after the
		// previous one had faded out (~280ms per j/k), so the reader is keyed
		// with an enter-only CSS fade.
		const w = mountOverlay('m2');
		await w.setProps({ message: msg('m3') as never });
		const readers = w.findAll('.reader-stub');
		expect(readers).toHaveLength(1);
		expect(readers[0]!.attributes('data-id')).toBe('m3');
		expect(readers[0]!.classes()).toContain('pbx-reader-swap');
	});

	it("holds the pane with the skeleton until the reader's code arrives, then never again", async () => {
		let arrive: (reader: typeof readerStub) => void = () => {};
		const lazyReader = defineAsyncComponent(
			() => new Promise<typeof readerStub>((resolve) => (arrive = resolve))
		);
		wrapper = mount(PostboxTodayReaderOverlay, {
			attachTo: document.body,
			props: { message: msg('m2') as never, advanceIds: ['m1', 'm2', 'm3'] },
			global: {
				plugins: [createTestI18n()],
				components: { LazyPostboxThreadReader: lazyReader },
				stubs: overlayStubs,
			},
		});
		await nextTick();
		expect(wrapper.find('.skeleton-stub').exists()).toBe(true);
		expect(wrapper.find('.reader-stub').exists()).toBe(false);

		arrive(readerStub);
		await flushPromises();
		expect(wrapper.find('.reader-stub').attributes('data-id')).toBe('m2');
		expect(wrapper.find('.skeleton-stub').exists()).toBe(false);

		await wrapper.setProps({ message: msg('m3') as never });
		expect(wrapper.find('.skeleton-stub').exists()).toBe(false);
		expect(wrapper.find('.reader-stub').attributes('data-id')).toBe('m3');
	});

	it('arrow keys mirror j/k and the ends are a no-op', () => {
		const w = mountOverlay('m3');
		pressOnWindow('ArrowDown'); // already last — stays put
		pressOnWindow('ArrowUp');
		expect(w.emitted('open')).toEqual([['m2']]);
		expect(w.emitted('close')).toBeUndefined();
	});

	it('Escape closes; unmount restores focus to the opener', async () => {
		const opener = document.createElement('button');
		opener.id = 'opener';
		document.body.appendChild(opener);
		onTestFinished(() => opener.remove());
		opener.focus();
		const w = mountOverlay();
		await nextTick();
		// The pane took focus on open (so list shortcuts stop landing underneath).
		expect(document.activeElement?.getAttribute('role')).toBe('dialog');
		pressOnWindow('Escape');
		expect(w.emitted('close')).toHaveLength(1);
		w.unmount();
		wrapper = undefined;
		expect(document.activeElement).toBe(opener);
	});

	it('offers a labelled Close button, the exit a touch user can reach', async () => {
		const w = mountOverlay();
		const button = w.get('[data-testid="postbox-today-overlay-close"]');
		expect(button.attributes('aria-label')).toBe('Close conversation');
		await button.trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('shows the loading, failed and gone states while it has no message', async () => {
		wrapper = mount(PostboxTodayReaderOverlay, {
			attachTo: document.body,
			props: { messageId: 'm-old', advanceIds: ['m-old'] },
			global: {
				plugins: [createTestI18n()],
				components: { LazyPostboxThreadReader: readerStub },
				stubs: overlayStubs,
			},
		});
		expect(wrapper.find('[data-testid="postbox-today-overlay-loading"]').exists()).toBe(true);

		await wrapper.setProps({ error: new Error('boom') });
		await wrapper.get('.retry-stub').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);

		await wrapper.setProps({ error: null, notFound: true });
		expect(wrapper.find('.gone-stub').exists()).toBe(true);
		expect(wrapper.find('.reader-stub').exists()).toBe(false);
	});

	it('scrim click closes', async () => {
		const w = mountOverlay();
		await w.find('[data-overlay-scrim]').trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('stays inert for text-entry targets and while another dialog is open', async () => {
		const w = mountOverlay();
		const input = document.createElement('input');
		document.body.appendChild(input);
		onTestFinished(() => input.remove());
		input.focus();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(w.emitted('open')).toBeUndefined();
		expect(w.emitted('close')).toBeUndefined();

		input.remove();
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog'); // e.g. the snooze picker
		document.body.appendChild(dialog);
		onTestFinished(() => dialog.remove());
		pressOnWindow('Escape');
		expect(w.emitted('close')).toBeUndefined();
	});

	it('forwards triage keys to the reader bridge while focus is inside the pane', async () => {
		const w = mountOverlay();
		await nextTick();
		const actions: string[] = [];
		const onAction = (e: Event) =>
			actions.push(String((e as CustomEvent<{ action?: string }>).detail?.action));
		window.addEventListener('owlat:postbox-reader-action', onAction);
		try {
			const pane = w.find('[role="dialog"]').element as HTMLElement;
			pane.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true })
			);
			expect(actions).toEqual(['archive']);
		} finally {
			window.removeEventListener('owlat:postbox-reader-action', onAction);
		}
	});

	it("maps the reader's advance to open / close", () => {
		const w = mountOverlay();
		const reader = w.findComponent(readerStub);
		// The hosted reader runs in-place advance mode against the Today order.
		expect(reader.props('advanceInPlace')).toBe(true);
		expect(reader.props('folderRole')).toBe('inbox');
		reader.vm.$emit('advance', 'm3');
		reader.vm.$emit('advance', null);
		expect(w.emitted('open')).toEqual([['m3']]);
		expect(w.emitted('close')).toHaveLength(1);
	});
});
