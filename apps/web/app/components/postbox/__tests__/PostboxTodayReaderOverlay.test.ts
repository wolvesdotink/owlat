// @vitest-environment happy-dom
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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

import PostboxTodayReaderOverlay from '../PostboxTodayReaderOverlay.vue';

const readerStub = {
	props: ['message', 'advanceIds', 'folderRole', 'advanceInPlace'],
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

let wrapper: VueWrapper | undefined;
afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	document.body.innerHTML = '';
});

function mountOverlay(id = 'm2', advanceIds = ['m1', 'm2', 'm3']) {
	wrapper = mount(PostboxTodayReaderOverlay, {
		attachTo: document.body,
		props: { message: msg(id) as never, advanceIds },
		global: { components: { PostboxThreadReader: readerStub } },
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

	it('scrim click closes', async () => {
		const w = mountOverlay();
		await w.find('[data-overlay-scrim]').trigger('click');
		expect(w.emitted('close')).toHaveLength(1);
	});

	it('stays inert for text-entry targets and while another dialog is open', async () => {
		const w = mountOverlay();
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(w.emitted('open')).toBeUndefined();
		expect(w.emitted('close')).toBeUndefined();

		input.remove();
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog'); // e.g. the snooze picker
		document.body.appendChild(dialog);
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
