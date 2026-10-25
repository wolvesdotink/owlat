/**
 * "Quote in reply" over a real message frame.
 *
 * A same-origin, script-free iframe renders a `srcdoc` body exactly as
 * PostboxMessageBody frames one, wired to the real selection owner and the
 * real pill the way the body wires them. The selection is made in the frame's
 * own document, so `selectionchange` comes from the browser; Playwright clicks
 * the pill and presses the reply key with focus inside the frame, where the
 * reader's window listener never hears it. happy-dom has neither native
 * iframe selections nor layout, which is what these tests need.
 */
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import PostboxQuoteReplyPill from '~/components/postbox/PostboxQuoteReplyPill.vue';
import { usePostboxFrameSelection } from '~/composables/postbox/usePostboxFrameSelection';
import { nextEvent, scrollTo } from './events';

const BODY =
	'<!doctype html><html><body style="margin:0;font:16px sans-serif">' +
	'<p>Hi there,</p><p id="ask">We were billed twice on the 14th for the same seat count.</p>' +
	'<p>Thanks,<br>Ines</p></body></html>';

function mountBody() {
	const quotes: string[] = [];
	const srcdoc = ref(BODY);
	const Host = defineComponent({
		setup() {
			const iframeRef = ref<HTMLIFrameElement | null>(null);
			const box = ref<HTMLElement | null>(null);
			const pill = ref<{ el: HTMLElement | null; focus: () => void } | null>(null);
			const frameSelection = usePostboxFrameSelection({
				iframeRef,
				srcdoc,
				enabled: () => true,
				onQuote: quote,
				actionEl: () => pill.value?.el ?? null,
				focusAction: () => pill.value?.focus(),
			});
			function quote(text: string) {
				frameSelection.clear();
				quotes.push(text);
			}
			return () => {
				const selected = frameSelection.selection.value;
				return h('div', { ref: box, class: 'relative', style: 'width:600px' }, [
					h('iframe', {
						ref: iframeRef,
						srcdoc: srcdoc.value,
						sandbox: 'allow-same-origin',
						style: 'display:block;width:100%;height:240px;border:0',
					}),
					selected
						? h(PostboxQuoteReplyPill, {
								ref: pill,
								anchor: selected.anchor,
								boundsWidth: box.value?.clientWidth ?? 0,
								onQuote: () => quote(selected.text),
								onDismiss: () => frameSelection.clear(),
							})
						: null,
				]);
			};
		},
	});
	const Page = defineComponent({
		setup: () => () =>
			h('div', { 'data-testid': 'scroller', style: 'height:300px;overflow:auto' }, [
				h('div', { style: 'height:120px' }),
				h(Host),
				h('div', { style: 'height:800px' }),
			]),
	});
	const wrapper = mount(Page, { attachTo: document.body });
	const iframe = wrapper.get<HTMLIFrameElement>('iframe').element;
	const scroller = wrapper.get<HTMLElement>('[data-testid="scroller"]').element;
	const pill = () => document.querySelector<HTMLElement>('[data-testid="quote-reply-pill"]');
	return { wrapper, iframe, scroller, pill, quotes, srcdoc };
}

async function loaded(iframe: HTMLIFrameElement) {
	const doc = iframe.contentDocument;
	if (!doc || doc.URL === 'about:blank' || doc.readyState !== 'complete') {
		await nextEvent(iframe, 'load');
	}
	return iframe.contentDocument!;
}

/** Select the `#ask` paragraph in the frame and wait for the pill. */
async function selectAsk(iframe: HTMLIFrameElement) {
	const doc = await loaded(iframe);
	iframe.contentWindow!.focus();
	const changed = nextEvent(doc, 'selectionchange');
	const range = doc.createRange();
	range.selectNodeContents(doc.getElementById('ask')!);
	doc.getSelection()!.removeAllRanges();
	doc.getSelection()!.addRange(range);
	await changed;
	await nextTick();
	await nextTick();
	return { doc, range };
}

describe('Quote in reply', () => {
	it('shows the pill under the selected passage, and it follows the body as it scrolls', async () => {
		const { iframe, scroller, pill } = mountBody();
		expect(pill()).toBeNull();
		const { range } = await selectAsk(iframe);

		const place = () => {
			const lines = range.getClientRects();
			const last = lines[lines.length - 1]!;
			const frame = iframe.getBoundingClientRect();
			return { pill: pill()!.getBoundingClientRect(), lineBottom: frame.top + last.bottom, frame };
		};
		const before = place();
		expect(before.pill.top).toBeGreaterThanOrEqual(before.lineBottom);
		expect(before.pill.top - before.lineBottom).toBeLessThan(16);
		expect(before.pill.left).toBeGreaterThanOrEqual(before.frame.left);
		expect(before.pill.right).toBeLessThanOrEqual(before.frame.right);
		expect(pill()!.textContent).toContain('Quote in reply');

		await scrollTo(scroller, 90);
		const after = place();
		expect(after.pill.top - after.lineBottom).toBeCloseTo(before.pill.top - before.lineBottom, 0);
		expect(after.pill.top).toBeCloseTo(before.pill.top - 90, 0);
	});

	it('quotes once from the pill, keeping the selection through the press', async () => {
		const { iframe, pill, quotes } = mountBody();
		const { doc } = await selectAsk(iframe);
		const text = 'We were billed twice on the 14th for the same seat count.';

		pill()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
		expect(doc.getSelection()!.toString()).toBe(text);

		await userEvent.click(pill()!);
		expect(quotes).toEqual([text]);
		await nextTick();
		expect(pill()).toBeNull();
	});

	it('quotes once with the reply key pressed inside the frame', async () => {
		const { iframe, quotes } = mountBody();
		await selectAsk(iframe);
		await userEvent.keyboard('r');
		expect(quotes).toEqual(['We were billed twice on the 14th for the same seat count.']);
	});

	it('lets go of the selection on Escape inside the frame', async () => {
		const { iframe, pill, quotes } = mountBody();
		const { doc } = await selectAsk(iframe);
		await userEvent.keyboard('{Escape}');
		await nextTick();
		expect(pill()).toBeNull();
		expect(doc.getSelection()!.isCollapsed).toBe(true);
		await userEvent.keyboard('r');
		expect(quotes).toEqual([]);
	});

	it('drops the pill when the frame renders a new document, and works on the new one', async () => {
		const { iframe, pill, quotes, srcdoc } = mountBody();
		await selectAsk(iframe);
		expect(pill()).not.toBeNull();

		const reloaded = nextEvent(iframe, 'load');
		srcdoc.value = BODY.replace('Hi there,', 'Hello again,');
		await nextTick();
		expect(pill()).toBeNull();
		await reloaded;

		await selectAsk(iframe);
		expect(pill()).not.toBeNull();
		await userEvent.keyboard('r');
		expect(quotes).toEqual(['We were billed twice on the 14th for the same seat count.']);
	});
});
