/**
 * The reader's sticky bar: hidden while the header line is on screen, shown
 * once it has scrolled away, and its subject goes back to the top with focus
 * on the header, not on <body>. Reply, Archive and the host's slots work from
 * the bar as from the header.
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxReaderStickyBar from '../PostboxReaderStickyBar.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

/**
 * happy-dom does no layout, so the test places things: the anchor sticks at
 * the scroller's top once the article has scrolled 24px, and the 80px header
 * starts 24px into the content.
 */
async function mountBar(props: { subject?: string; sender?: string } = {}) {
	const scroller = document.createElement('div');
	scroller.style.overflowY = 'auto';
	let scrollTop = 0;
	scroller.scrollTo = vi.fn((opts?: ScrollToOptions | number) => {
		scrollTop = typeof opts === 'object' ? (opts.top ?? scrollTop) : scrollTop;
		scroller.dispatchEvent(new Event('scroll'));
	}) as typeof scroller.scrollTo;
	const header = document.createElement('header');
	header.tabIndex = -1;
	header.getBoundingClientRect = () =>
		({ top: 24 - scrollTop, bottom: 104 - scrollTop }) as DOMRect;
	const host = document.createElement('div');
	scroller.append(host, header);
	document.body.append(scroller);
	onTestFinished(() => scroller.remove());

	const w = mount(PostboxReaderStickyBar, {
		props: { subject: 'Invoice 4471', sender: 'Ada Lovelace', header, ...props },
		slots: {
			lead: '<button data-testid="lead">Unsubscribe</button>',
			default: '<button data-testid="menu">More</button>',
		},
		global: { plugins: [createTestI18n()] },
		attachTo: host,
	});
	onTestFinished(() => w.unmount());
	(w.element as HTMLElement).getBoundingClientRect = () => {
		const top = Math.max(0, 24 - scrollTop);
		return { top, bottom: top } as DOMRect;
	};
	await nextTick();
	return {
		w,
		header,
		scroller,
		async scrollTo(top: number) {
			scrollTop = top;
			scroller.dispatchEvent(new Event('scroll'));
			await nextTick();
		},
		bar: () => w.get('[data-testid="reader-sticky-bar"]').element as HTMLElement,
	};
}

describe('PostboxReaderStickyBar', () => {
	it('stays hidden until the header has scrolled away, and hides again on the way back', async () => {
		const r = await mountBar();
		expect(r.bar().style.display).toBe('none');

		await r.scrollTo(60);
		expect(r.bar().style.display).toBe('none');

		await r.scrollTo(200);
		expect(r.bar().style.display).toBe('');

		await r.scrollTo(0);
		expect(r.bar().style.display).toBe('none');
	});

	it('shows the subject and sender, and the host slots around Reply and Archive', async () => {
		const r = await mountBar();
		const text = r.w.get('[data-testid="reader-sticky-bar-subject"]').text();
		expect(text).toContain('Invoice 4471');
		expect(text).toContain('Ada Lovelace');
		const order = [...r.bar().querySelectorAll('[data-testid]')].map((el) =>
			el.getAttribute('data-testid')
		);
		expect(order).toEqual([
			'reader-sticky-bar-subject',
			'lead',
			'reader-sticky-bar-reply',
			'reader-sticky-bar-archive',
			'menu',
		]);
	});

	it('names a subjectless conversation the way the header does', async () => {
		const r = await mountBar({ subject: '' });
		expect(r.w.get('[data-testid="reader-sticky-bar-subject"]').text()).toContain('(no subject)');
	});

	it('the subject goes back to the top and leaves focus on the header', async () => {
		const r = await mountBar();
		await r.scrollTo(400);
		const subject = r.w.get('[data-testid="reader-sticky-bar-subject"]');
		(subject.element as HTMLElement).focus();
		await subject.trigger('click');
		expect(r.scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
		expect(document.activeElement).toBe(r.header);
		await nextTick();
		expect(r.bar().style.display).toBe('none');
	});

	it('Reply and Archive emit their verbs', async () => {
		const r = await mountBar();
		await r.scrollTo(400);
		await r.w.get('[data-testid="reader-sticky-bar-reply"]').trigger('click');
		await r.w.get('[data-testid="reader-sticky-bar-archive"]').trigger('click');
		expect(r.w.emitted('reply')).toHaveLength(1);
		expect(r.w.emitted('archive')).toHaveLength(1);
	});
});
