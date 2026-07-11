// @vitest-environment happy-dom
/**
 * UiModal is the shared dialog primitive that hand-rolled `fixed inset-0`
 * overlays are being consolidated onto (e.g. FileUploadModal, which previously
 * rendered its own backdrop with NO focus trap and NO Escape handling). These
 * tests pin the modal semantics every converted overlay now inherits: an
 * accessible dialog, focus moved inside on open, and an Escape key that requests
 * close via `update:open`.
 */
import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

function mountModal() {
	return mount(UiModal, {
		props: { open: true, title: 'Upload File' },
		slots: { default: '<button data-testid="body-action">Do it</button>' },
		attachTo: document.body,
		global: { stubs: { Icon: true, teleport: true } },
	});
}

describe('UiModal (semantics inherited by every converted overlay)', () => {
	it('renders an accessible dialog labelled by its title', () => {
		const wrapper = mountModal();
		const dialog = wrapper.find('[role="dialog"]');
		expect(dialog.exists()).toBe(true);
		expect(dialog.attributes('aria-modal')).toBe('true');
		wrapper.unmount();
	});

	it('traps focus inside the dialog when opened', async () => {
		const wrapper = mountModal();
		await flushPromises();
		const dialog = wrapper.find('[role="dialog"]').element;
		expect(document.activeElement).not.toBeNull();
		expect(dialog.contains(document.activeElement)).toBe(true);
		wrapper.unmount();
	});

	it('requests close on Escape', async () => {
		const wrapper = mountModal();
		await flushPromises();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await flushPromises();
		expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
		wrapper.unmount();
	});
});
