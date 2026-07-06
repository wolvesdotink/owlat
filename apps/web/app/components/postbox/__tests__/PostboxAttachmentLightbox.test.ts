import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';

// The component references useModalFocus as a Nuxt auto-import (provided by
// the @owlat/ui layer); wire the real implementation in as a global so the
// test exercises the actual focus-trap/restore behavior.
import { useModalFocus } from '@owlat/ui/composables/useModalFocus';
import PostboxAttachmentLightbox from '../PostboxAttachmentLightbox.vue';

vi.stubGlobal('useModalFocus', useModalFocus);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const attachments = [
	{ filename: 'photo-a.png', contentType: 'image/png', size: 1024, partIndex: '1' },
	{ filename: 'photo-b.jpg', contentType: 'image/jpeg', size: 2048, partIndex: '2' },
	{ filename: 'report.pdf', contentType: 'application/pdf', size: 4096, partIndex: '3' },
];

let urlCounter = 0;
const createObjectURL = vi.fn(() => `blob:mock-${++urlCounter}`);
const revokeObjectURL = vi.fn();

let wrapper: VueWrapper | undefined;
let opener: HTMLButtonElement;

function mountLightbox(initialIndex = 0, loadPart?: (att: unknown) => Promise<Blob | null>) {
	wrapper = mount(PostboxAttachmentLightbox, {
		props: {
			attachments,
			initialIndex,
			loadPart:
				loadPart ??
				(async (att: { contentType: string }) => new Blob(['x'], { type: att.contentType })),
		},
		attachTo: document.body,
		// Teleport renders in place so wrapper queries reach the overlay; Icon
		// is a Nuxt component, stubbed inert.
		global: { stubs: { Teleport: true, Icon: true } },
	});
	return wrapper;
}

beforeEach(() => {
	urlCounter = 0;
	createObjectURL.mockClear();
	revokeObjectURL.mockClear();
	Object.assign(URL, { createObjectURL, revokeObjectURL });
	// A focused "opener" outside the overlay, to verify focus restore on close.
	opener = document.createElement('button');
	opener.textContent = 'open preview';
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = undefined;
	opener.remove();
});

describe('PostboxAttachmentLightbox', () => {
	it('opens at the clicked index and creates an object URL for that part', async () => {
		const w = mountLightbox(1);
		await flush();
		await nextTick();

		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(w.text()).toContain('photo-b.jpg');
		expect(w.text()).toContain('2 of 3');
		const img = w.get('img');
		expect(img.attributes('src')).toBe('blob:mock-1');
		expect(revokeObjectURL).not.toHaveBeenCalled();
	});

	it('advances on ArrowRight and revokes the prior object URL', async () => {
		const w = mountLightbox(0);
		await flush();
		await nextTick();
		expect(w.get('img').attributes('src')).toBe('blob:mock-1');

		await w.get('[role="dialog"]').trigger('keydown', { key: 'ArrowRight' });
		await flush();
		await nextTick();

		expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
		expect(createObjectURL).toHaveBeenCalledTimes(2);
		expect(w.get('img').attributes('src')).toBe('blob:mock-2');
		expect(w.text()).toContain('photo-b.jpg');
	});

	it('renders a PDF part via <object> instead of <img>', async () => {
		const w = mountLightbox(2);
		await flush();
		await nextTick();

		expect(w.find('img').exists()).toBe(false);
		const obj = w.get('object');
		expect(obj.attributes('data')).toBe('blob:mock-1');
		expect(obj.attributes('type')).toBe('application/pdf');
	});

	it('does not advance past the last attachment', async () => {
		const w = mountLightbox(2);
		await flush();
		await nextTick();

		await w.get('[role="dialog"]').trigger('keydown', { key: 'ArrowRight' });
		await flush();

		expect(createObjectURL).toHaveBeenCalledTimes(1);
		expect(w.text()).toContain('3 of 3');
	});

	it('keeps focus in the dialog when a clicked chevron unmounts at the boundary and ArrowLeft still navigates', async () => {
		// Mounted with the REAL Teleport: the boundary refocus depends on DOM
		// element identity surviving re-renders, which the teleport stub does
		// not preserve (it re-creates the whole subtree on every patch).
		wrapper = mount(PostboxAttachmentLightbox, {
			props: {
				attachments,
				initialIndex: 1,
				loadPart: async (att: { contentType: string }) =>
					new Blob(['x'], { type: att.contentType }),
			},
			attachTo: document.body,
			global: { stubs: { Icon: true } },
		});
		await flush();
		await nextTick();

		// Mouse-click "next": the browser focuses the clicked chevron.
		const nextChevron = document.body.querySelector<HTMLElement>('[aria-label="Next attachment"]')!;
		nextChevron.focus();
		nextChevron.click();
		await flush();
		await nextTick();
		await flush();

		// At the last attachment the clicked chevron unmounted (v-if="hasNext");
		// focus must not escape to document.body — that would kill arrow-key
		// navigation, break the focus trap, and leak triage shortcuts to the
		// thread underneath.
		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.textContent).toContain('3 of 3');
		expect(document.body.querySelector('[aria-label="Next attachment"]')).toBeNull();
		expect(dialog.contains(document.activeElement)).toBe(true);

		// Arrow-key navigation still works from the focused element.
		(document.activeElement as HTMLElement).dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
		);
		await flush();
		await nextTick();
		expect(dialog.textContent).toContain('2 of 3');
	});

	it('closes on Escape, restores focus to the opener, and revokes the URL', async () => {
		const w = mountLightbox(0);
		await flush();
		await nextTick();
		// Focus moved into the dialog on open.
		expect(document.activeElement).not.toBe(opener);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await nextTick();
		await nextTick();

		expect(w.emitted('close')).toHaveLength(1);
		expect(document.activeElement).toBe(opener);

		// The parent unmounts the overlay on close — that must revoke the URL.
		w.unmount();
		wrapper = undefined;
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
	});

	it('shows the fallback state when extraction fails', async () => {
		const w = mountLightbox(0, async () => null);
		await flush();
		await nextTick();

		expect(createObjectURL).not.toHaveBeenCalled();
		expect(w.text()).toContain('Preview unavailable');
		expect(w.find('img').exists()).toBe(false);
	});

	it('emits download with the active attachment (reuses the parent download path)', async () => {
		const w = mountLightbox(1);
		await flush();
		await nextTick();

		await w.get('[aria-label="Download photo-b.jpg"]').trigger('click');
		expect(w.emitted('download')).toEqual([[attachments[1]]]);
	});
});
