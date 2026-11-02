/**
 * The message card's ⋯ menu leads with the sender's zoom: out, the current
 * size (which resets it) and in, each disabled where it would not move, and
 * the menu stays open while stepping. A message without a sender address has
 * no zoom to keep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { resetSenderZoomForTests, useSenderZoom } from '~/composables/useSenderZoom';
import PostboxReaderMessageActions from '../PostboxReaderMessageActions.vue';

const close = vi.fn();

beforeEach(() => {
	localStorage.clear();
	resetSenderZoomForTests();
	close.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast: vi.fn() }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
	});
});

afterEach(() => resetSenderZoomForTests());

function mountActions(fromAddress?: string) {
	return mount(PostboxReaderMessageActions, {
		props: { messageId: 'm1', starred: false, showReplyAll: false, fromAddress },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: { template: '<button type="button"><slot /></button>' },
				PostboxOverflowMenu: {
					setup: () => ({ close }),
					template: '<div role="menu"><slot :close="close" /></div>',
				},
			},
		},
	});
}

const control = (wrapper: ReturnType<typeof mountActions>, label: string) =>
	wrapper.get(`[role="group"] [aria-label="${label}"]`);

describe('PostboxReaderMessageActions sender zoom', () => {
	it('steps the sender’s zoom from the ⋯ menu and keeps the menu open', async () => {
		const wrapper = mountActions('News <news@example.com>');
		const zoomIn = control(wrapper, "Zoom in on this sender's mail");
		expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Zoom');
		expect(control(wrapper, "Reset this sender's zoom (now 100%)").attributes()).toHaveProperty(
			'disabled'
		);

		await zoomIn.trigger('click');
		await zoomIn.trigger('click');
		expect(useSenderZoom().zoomOf('news@example.com')).toBe(125);
		const reset = control(wrapper, "Reset this sender's zoom (now 125%)");
		expect(reset.text()).toBe('125%');
		expect(close).not.toHaveBeenCalled();

		await reset.trigger('click');
		expect(useSenderZoom().zoomOf('news@example.com')).toBe(100);
	});

	it('disables a step at the end of the scale', async () => {
		const { applyZoom } = useSenderZoom();
		for (let i = 0; i < 10; i++) applyZoom('news@example.com', 'zoomOut');
		const wrapper = mountActions('news@example.com');
		expect(control(wrapper, "Zoom out on this sender's mail").attributes()).toHaveProperty(
			'disabled'
		);
		expect(control(wrapper, "Zoom in on this sender's mail").attributes()).not.toHaveProperty(
			'disabled'
		);
	});

	it('offers no zoom for a message without a sender address', () => {
		expect(mountActions('Undisclosed recipients').find('[role="group"]').exists()).toBe(false);
		expect(mountActions().find('[role="group"]').exists()).toBe(false);
	});
});
