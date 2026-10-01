// @vitest-environment happy-dom
/**
 * Answer mode on a phone opens with the message being answered in view: when
 * the column fills in and that message (`data-answer-anchor`) lands below the
 * fold, it is scrolled to the top. Once the person scrolls or taps in the
 * column, the view is theirs and nothing moves it again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useAnswerAnchor } from '../useAnswerAnchor';

let rafs: FrameRequestCallback[] = [];
beforeEach(() => {
	rafs = [];
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafs.push(cb));
	vi.stubGlobal('cancelAnimationFrame', () => {});
});
const flushFrames = async () => {
	await nextTick();
	await Promise.resolve();
	const pending = rafs;
	rafs = [];
	for (const cb of pending) cb(0);
};

function setup(opts: { active?: boolean; anchorTop: number }) {
	const column = ref<HTMLElement | null>(null);
	const scrolled = vi.fn();
	const wrapper = mount(
		defineComponent({
			setup() {
				useAnswerAnchor({ column, active: () => opts.active ?? true });
				return () => h('section', { ref: column });
			},
		}),
		{ attachTo: document.body }
	);
	column.value!.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
	function addAnchor() {
		const anchor = document.createElement('article');
		anchor.setAttribute('data-answer-anchor', '');
		anchor.getBoundingClientRect = () => ({ top: opts.anchorTop }) as DOMRect;
		anchor.scrollIntoView = scrolled;
		column.value!.appendChild(anchor);
	}
	return { wrapper, column, scrolled, addAnchor };
}

describe('useAnswerAnchor', () => {
	it('scrolls the answered message to the top when it arrives below the fold', async () => {
		const { scrolled, addAnchor } = setup({ anchorTop: 900 });
		addAnchor();
		await flushFrames();
		expect(scrolled).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
	});

	it('leaves a message that is already in view alone', async () => {
		const { scrolled, addAnchor } = setup({ anchorTop: 200 });
		addAnchor();
		await flushFrames();
		expect(scrolled).not.toHaveBeenCalled();
	});

	it('stops once the person scrolls the column themselves', async () => {
		const { column, scrolled, addAnchor } = setup({ anchorTop: 900 });
		column.value!.dispatchEvent(new Event('wheel'));
		addAnchor();
		await flushFrames();
		expect(scrolled).not.toHaveBeenCalled();
	});

	it('does nothing side by side, where both columns have the room', async () => {
		const { scrolled, addAnchor } = setup({ anchorTop: 900, active: false });
		addAnchor();
		await flushFrames();
		expect(scrolled).not.toHaveBeenCalled();
	});
});
