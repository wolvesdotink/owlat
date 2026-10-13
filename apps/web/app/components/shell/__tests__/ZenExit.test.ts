// @vitest-environment happy-dom
/**
 * Zen mode's keys: Cmd/Ctrl+Shift+F toggles it unless a surface claimed the
 * chord, and Esc leaves it BEFORE the page sees the press, so one press is one
 * action. A dialog, a text field or a page that owns Esc keeps it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useZenMode } from '~/composables/useZenMode';
import { useEscapeToClose } from '~/composables/useEscapeToClose';
import ZenExit from '../ZenExit.vue';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useAnnounce', () => ({ announce: vi.fn() }));
});

let wrapper: VueWrapper | null = null;
const pageEscape = vi.fn();

function mountExit(props: { showBar?: boolean; pageOwnsEscape?: boolean } = {}) {
	wrapper = mount(ZenExit, {
		attachTo: document.body,
		props: { showBar: true, pageOwnsEscape: false, ...props },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
	return wrapper;
}

function press(init: KeyboardEventInit, target: EventTarget = document.body) {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

const onDocumentKeydown = (event: KeyboardEvent) => {
	if (event.key === 'Escape') pageEscape();
};

beforeEach(() => {
	useZenMode().exitZen();
	pageEscape.mockClear();
	document.addEventListener('keydown', onDocumentKeydown);
});
afterEach(() => {
	document.removeEventListener('keydown', onDocumentKeydown);
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

describe('ZenExit', () => {
	it('toggles Zen on Cmd/Ctrl+Shift+F', async () => {
		mountExit();
		press({ key: 'F', ctrlKey: true, shiftKey: true });
		expect(useZenMode().isZen.value).toBe(true);
		press({ key: 'F', ctrlKey: true, shiftKey: true });
		expect(useZenMode().isZen.value).toBe(false);
	});

	it('leaves the chord to a surface that claimed it first', () => {
		mountExit();
		const claim = (event: KeyboardEvent) => event.preventDefault();
		document.addEventListener('keydown', claim);
		press({ key: 'F', metaKey: true, shiftKey: true });
		document.removeEventListener('keydown', claim);
		expect(useZenMode().isZen.value).toBe(false);
	});

	it('takes the first Esc for itself; the page only hears the next one', async () => {
		mountExit();
		useZenMode().enterZen();
		await nextTick();
		press({ key: 'Escape' });
		expect(useZenMode().isZen.value).toBe(false);
		expect(pageEscape).not.toHaveBeenCalled();
		await nextTick();
		press({ key: 'Escape' });
		expect(pageEscape).toHaveBeenCalledTimes(1);
	});

	it('leaves Esc to an open dialog, a text field and a page that owns it', async () => {
		mountExit();
		useZenMode().enterZen();
		await nextTick();

		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog');
		document.body.append(dialog);
		press({ key: 'Escape' });
		dialog.remove();

		const input = document.createElement('input');
		document.body.append(input);
		press({ key: 'Escape' }, input);

		expect(useZenMode().isZen.value).toBe(true);
		expect(pageEscape).toHaveBeenCalledTimes(2);

		wrapper?.unmount();
		mountExit({ pageOwnsEscape: true });
		await nextTick();
		press({ key: 'Escape' });
		expect(useZenMode().isZen.value).toBe(true);
	});

	it('lets a popover opened in Zen close first, and leaves Zen on the next press', async () => {
		mountExit();
		useZenMode().enterZen();
		await nextTick();
		const open = ref(false);
		const popover = mount(
			defineComponent({
				setup() {
					useEscapeToClose(open);
					return () => h('div');
				},
			})
		);
		open.value = true;
		await nextTick();

		press({ key: 'Escape' });
		expect(open.value).toBe(false);
		expect(useZenMode().isZen.value).toBe(true);
		await nextTick();
		press({ key: 'Escape' });
		expect(useZenMode().isZen.value).toBe(false);
		expect(pageEscape).not.toHaveBeenCalled();
		popover.unmount();
	});

	it('shows "Exit Zen" only in Zen, and it leaves Zen', async () => {
		const w = mountExit();
		expect(w.find('[data-testid="zen-exit"]').exists()).toBe(false);
		useZenMode().enterZen();
		await w.vm.$nextTick();
		await w.find('[data-testid="zen-exit"]').trigger('click');
		expect(useZenMode().isZen.value).toBe(false);
	});

	it('brings no bar where the page brings its own way out', async () => {
		const w = mountExit({ showBar: false });
		useZenMode().enterZen();
		await w.vm.$nextTick();
		expect(w.find('[data-testid="zen-exit"]').exists()).toBe(false);
	});
});
