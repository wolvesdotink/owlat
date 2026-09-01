// @vitest-environment happy-dom
/**
 * UiModal is the shared dialog primitive that hand-rolled `fixed inset-0`
 * overlays are being consolidated onto (e.g. FileUploadModal, which previously
 * rendered its own backdrop with NO focus trap and NO Escape handling). These
 * tests pin the modal semantics every converted overlay now inherits: an
 * accessible dialog, focus moved inside on open, and an Escape key that requests
 * close via `update:open`.
 *
 * They also pin the panel's geometry, because that is a behaviour and not a
 * decoration: the panel used to grow with its content past the bottom of the
 * viewport, which put the submit button of a tall form physically out of reach
 * on a phone. ~55 call sites bolted their own `max-h-[70vh]` onto the body to
 * work around it. The panel now owns the scroll — pinned header, scrolling
 * body, pinned footer — so those patches can be deleted.
 */
import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import UiModal from '@owlat/ui/components/ui/Modal.vue';

type Overrides = {
	persistent?: boolean;
	closable?: boolean;
	size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | 'full';
};

function mountModal(overrides: Overrides = {}) {
	return mount(UiModal, {
		props: { open: true, title: 'Upload File', ...overrides },
		slots: { default: '<button data-testid="body-action">Do it</button>' },
		attachTo: document.body,
		global: { stubs: { Icon: true, teleport: true } },
	});
}

/** The scrolling region: the panel's only child that is allowed to overflow. */
function bodyOf(wrapper: ReturnType<typeof mountModal>) {
	return wrapper.find('[role="dialog"] > .overflow-y-auto');
}

function grip(wrapper: ReturnType<typeof mountModal>) {
	return wrapper.find('.modal-grip');
}

/** happy-dom lays nothing out, so `offsetHeight` is 0 and the floor applies. */
const PAST_THRESHOLD = 200;
const UNDER_THRESHOLD = 20;

async function swipe(wrapper: ReturnType<typeof mountModal>, distance: number) {
	const handle = grip(wrapper);
	await handle.trigger('pointerdown', { clientY: 0, pointerId: 1 });
	await handle.trigger('pointermove', { clientY: distance, pointerId: 1 });
	await handle.trigger('pointerup', { clientY: distance, pointerId: 1 });
	await flushPromises();
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

	it('leaves a persistent dialog open on Escape', async () => {
		const wrapper = mountModal({ persistent: true });
		await flushPromises();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await flushPromises();
		expect(wrapper.emitted('update:open')).toBeUndefined();
		wrapper.unmount();
	});
});

describe('UiModal panel geometry (the call sites no longer patch this)', () => {
	it('caps the panel height and lays it out as a flex column', () => {
		const wrapper = mountModal();
		const classes = wrapper.find('[role="dialog"]').classes();
		expect(classes).toContain('flex');
		expect(classes).toContain('flex-col');
		expect(classes).toContain('max-h-[85dvh]');
		wrapper.unmount();
	});

	it('scrolls the body and nothing else', () => {
		const wrapper = mountModal();
		const body = bodyOf(wrapper);
		expect(body.exists()).toBe(true);
		// `min-h-0` is what actually lets a flex child shrink below its content
		// and scroll; without it the panel grows and the cap does nothing.
		expect(body.classes()).toContain('min-h-0');
		expect(body.classes()).toContain('flex-1');
		expect(wrapper.find('[role="dialog"]').classes()).not.toContain('overflow-y-auto');
		wrapper.unmount();
	});

	it('keeps the header and the footer outside the scrolling region', () => {
		const wrapper = mount(UiModal, {
			props: { open: true, title: 'Upload File' },
			slots: {
				default: '<p>body</p>',
				footer: '<button data-testid="submit">Save</button>',
			},
			attachTo: document.body,
			global: { stubs: { Icon: true, teleport: true } },
		});
		const body = bodyOf(wrapper).element;
		const heading = wrapper.find('h2').element;
		const submit = wrapper.find('[data-testid="submit"]').element;
		expect(body.contains(heading)).toBe(false);
		expect(body.contains(submit)).toBe(false);
		wrapper.unmount();
	});

	it('applies its width cap only from the sm breakpoint up, so the sheet is full-bleed', () => {
		const wrapper = mountModal({ size: 'lg' });
		const classes = wrapper.find('[role="dialog"]').classes();
		expect(classes).toContain('sm:max-w-lg');
		expect(classes).toContain('w-full');
		expect(classes).not.toContain('max-w-lg');
		wrapper.unmount();
	});
});

describe('UiModal bottom sheet (below the sm breakpoint)', () => {
	it('rounds only the top corners below sm', () => {
		const wrapper = mountModal();
		const classes = wrapper.find('[role="dialog"]').classes();
		expect(classes).toContain('rounded-t-2xl');
		expect(classes).toContain('sm:rounded-2xl');
		wrapper.unmount();
	});

	it('offers a drag handle when the dialog can be dismissed', () => {
		const wrapper = mountModal();
		expect(grip(wrapper).exists()).toBe(true);
		// Hidden on desktop: there is no sheet to drag there.
		expect(grip(wrapper).classes()).toContain('sm:hidden');
		wrapper.unmount();
	});

	it('offers no drag handle on a persistent dialog', () => {
		const wrapper = mountModal({ persistent: true });
		expect(grip(wrapper).exists()).toBe(false);
		wrapper.unmount();
	});

	it('follows the pointer down and dismisses past the threshold', async () => {
		const wrapper = mountModal();
		const handle = grip(wrapper);
		await handle.trigger('pointerdown', { clientY: 0, pointerId: 1 });
		await handle.trigger('pointermove', { clientY: PAST_THRESHOLD, pointerId: 1 });
		expect(wrapper.find('[role="dialog"]').attributes('style')).toContain(
			`translateY(${PAST_THRESHOLD}px)`
		);
		await handle.trigger('pointerup', { clientY: PAST_THRESHOLD, pointerId: 1 });
		await flushPromises();
		expect(wrapper.emitted('update:open')?.[0]).toEqual([false]);
		wrapper.unmount();
	});

	it('settles back without closing when the swipe is short', async () => {
		const wrapper = mountModal();
		await swipe(wrapper, UNDER_THRESHOLD);
		expect(wrapper.emitted('update:open')).toBeUndefined();
		// Released: the inline offset is gone, so the settle transition runs.
		expect(wrapper.find('[role="dialog"]').attributes('style')).toBeUndefined();
		wrapper.unmount();
	});

	it('ignores an upward swipe rather than tearing the sheet off the bottom edge', async () => {
		const wrapper = mountModal();
		const handle = grip(wrapper);
		await handle.trigger('pointerdown', { clientY: 300, pointerId: 1 });
		await handle.trigger('pointermove', { clientY: 100, pointerId: 1 });
		expect(wrapper.find('[role="dialog"]').attributes('style')).toBeUndefined();
		await handle.trigger('pointerup', { clientY: 100, pointerId: 1 });
		expect(wrapper.emitted('update:open')).toBeUndefined();
		wrapper.unmount();
	});

	it('ignores a pointer move that never started on the handle', async () => {
		const wrapper = mountModal();
		await grip(wrapper).trigger('pointermove', { clientY: PAST_THRESHOLD, pointerId: 1 });
		expect(wrapper.find('[role="dialog"]').attributes('style')).toBeUndefined();
		wrapper.unmount();
	});
});
