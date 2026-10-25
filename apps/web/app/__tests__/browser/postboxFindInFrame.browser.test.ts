/**
 * Find in conversation where only a real browser can say:
 *   - ⌘F pressed while a script-free body frame has the keyboard reaches the
 *     app's dispatcher, and the browser's own find is cancelled only when a
 *     reader took the press;
 *   - the frame's document is marked once it loads, and the active match is
 *     scrolled into view inside the reader's scroll container;
 *   - the bar opens on ⌘F with the keyboard in it, Escape closes it as the
 *     innermost layer (never the overlay around it) and focus goes back to
 *     where it was; the reader underneath an overlay does not answer.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue';
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import { setAppReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { usePostboxFindInFrame } from '~/composables/postbox/usePostboxFindInFrame';
import {
	usePostboxThreadFind,
	type PostboxMessageFind,
} from '~/composables/postbox/usePostboxThreadFind';
import { createPostboxFindIndex } from '~/composables/postbox/postboxFindIndex';
import PostboxThreadFindBar from '~/components/postbox/PostboxThreadFindBar.vue';
import { nextEvent } from './events';

const BODY = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<p>We asked for a refund on the 14th.</p>
<div style="height:1600px"></div>
<p id="far">The second refund is still open.</p>
</body></html>`;

/** A reader's scroll pane with one body frame far below the fold. */
function mountFrame(find: () => PostboxMessageFind | null) {
	const frame = ref<HTMLIFrameElement | null>(null);
	const Host = defineComponent({
		setup() {
			usePostboxFindInFrame({ frame, find });
			return () =>
				h('div', { 'data-testid': 'pane', style: 'height:300px;overflow:auto' }, [
					h('div', { style: 'height:900px' }),
					h('iframe', {
						ref: frame,
						srcdoc: BODY,
						sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
						style: 'display:block;width:600px;height:1800px;border:0',
					}),
				]);
		},
	});
	const wrapper = mount(Host, { attachTo: document.body });
	// Listened for after the composable's own listener (bound once mounted), so
	// the frame is marked by the time this resolves. A srcdoc loads in a task of
	// its own, never before the microtasks of the mount.
	const loaded = nextTick().then(() => nextEvent(frame.value!, 'load'));
	return { wrapper, frame, loaded };
}

/** Binds the find shortcut the way a reader does; counts the presses it took. */
function bindFind(answers: () => boolean = () => true) {
	const taken = { count: 0 };
	const Binder = defineComponent({
		setup() {
			useKeyboardShortcuts().registerShortcut({
				id: 'global.findInConversation',
				handler: () => {
					taken.count++;
				},
				when: answers,
			});
			return () => null;
		},
	});
	const wrapper = mount(Binder, { attachTo: document.body });
	return { taken, wrapper };
}

describe('find in conversation in a real browser', () => {
	it('hands ⌘F pressed inside a body frame to the reader, and only then cancels it', async () => {
		const { taken, wrapper: binder } = bindFind();
		const { frame, loaded } = mountFrame(() => null);
		await loaded;
		const win = frame.value!.contentWindow!;
		const prevented: boolean[] = [];
		const watcher = (event: KeyboardEvent) => prevented.push(event.defaultPrevented);
		win.addEventListener('keydown', watcher);
		onTestFinished(() => win.removeEventListener('keydown', watcher));

		win.focus();
		frame.value!.contentDocument!.body.focus();
		await userEvent.keyboard('{Control>}f{/Control}');
		expect(taken.count).toBe(1);
		expect(prevented.at(-1)).toBe(true);

		// No reader answers: the press stays the browser's.
		binder.unmount();
		await userEvent.keyboard('{Control>}f{/Control}');
		expect(taken.count).toBe(1);
		expect(prevented.at(-1)).toBe(false);
	});

	it('marks the frame once it loads and brings the active match into view', async () => {
		const find = shallowRef<PostboxMessageFind | null>({
			needle: 'refund',
			active: 1,
			forceQuoted: false,
			reveal: 1,
		});
		// Reduced motion scrolls in one step, so the position is final at once.
		setAppReducedMotion(true);
		onTestFinished(() => setAppReducedMotion(false));
		const { wrapper, frame, loaded } = mountFrame(() => find.value);
		await loaded;
		const pane = wrapper.get('[data-testid="pane"]').element as HTMLElement;
		expect(pane.scrollTop).toBeGreaterThan(0);
		const doc = frame.value!.contentDocument!;
		expect([...doc.querySelectorAll('mark[data-owlat-find]')].map((m) => m.textContent)).toEqual([
			'refund',
			'refund',
		]);
		const active = doc.querySelector('mark[data-owlat-find-active]')!;
		expect(active.closest('p')?.id).toBe('far');
		const frameTop = frame.value!.getBoundingClientRect().top;
		const markTop = frameTop + active.getBoundingClientRect().top;
		const paneRect = pane.getBoundingClientRect();
		expect(markTop).toBeGreaterThanOrEqual(paneRect.top);
		expect(markTop).toBeLessThanOrEqual(paneRect.bottom);

		// Closing find takes the marks away and leaves the words.
		find.value = null;
		await nextTick();
		await nextTick();
		expect(doc.querySelectorAll('mark[data-owlat-find]')).toHaveLength(0);
		expect(doc.getElementById('far')?.textContent).toBe('The second refund is still open.');
	});

	it('opens on ⌘F, closes on Escape inside an overlay, and gives focus back', async () => {
		let overlayEscapes = 0;
		const index = () =>
			createPostboxFindIndex({
				loadBody: () => new Promise(() => {}),
				render: () => ({ promise: new Promise(() => {}), cancel: () => {} }),
				parse: (html) => new DOMParser().parseFromString(html, 'text/html'),
			});
		const finds: Array<ReturnType<typeof usePostboxThreadFind>> = [];
		const Reader = defineComponent({
			props: { top: { type: Boolean, required: true } },
			setup(props) {
				const find = usePostboxThreadFind({
					threadKey: () => 't1',
					messages: () => [],
					searchable: () => true,
					isExpanded: () => true,
					expand: () => {},
					pages: {
						hasEarlier: ref(false),
						loadingEarlier: ref(false),
						earlierFailed: ref(false),
						loadEarlier: () => {},
					},
					answersShortcut: () => props.top,
					index: index(),
				});
				finds.push(find);
				return () =>
					h('div', [
						h('button', { 'data-testid': props.top ? 'opener' : 'under' }, 'Reply'),
						h(PostboxThreadFindBar, { find }),
					]);
			},
		});
		// The folder reader underneath, then the overlay with its own reader.
		const Page = defineComponent({
			setup() {
				useEscapeLayer(ref(true), () => {
					overlayEscapes++;
				});
				return () => h('div', [h(Reader, { top: false }), h(Reader, { top: true })]);
			},
		});
		const wrapper = mount(Page, { attachTo: document.body });
		const opener = wrapper.get('[data-testid="opener"]').element as HTMLButtonElement;
		opener.focus();

		await userEvent.keyboard('{Control>}f{/Control}');
		await nextTick();
		await nextTick();
		const [under, top] = finds;
		expect(under!.isOpen.value).toBe(false);
		expect(top!.isOpen.value).toBe(true);
		const input = wrapper.get('[data-testid="thread-find-input"]').element as HTMLInputElement;
		expect(document.activeElement).toBe(input);
		await userEvent.keyboard('refund');
		expect(top!.query.value).toBe('refund');

		await userEvent.keyboard('{Escape}');
		await nextTick();
		expect(top!.isOpen.value).toBe(false);
		expect(overlayEscapes).toBe(0);
		expect(document.activeElement).toBe(opener);

		// With the bar gone, Escape belongs to the overlay again.
		await userEvent.keyboard('{Escape}');
		expect(overlayEscapes).toBe(1);
	});
});
