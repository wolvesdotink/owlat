// @vitest-environment happy-dom
/**
 * "Please try again" with nothing to click was the dead end in #818: the alert
 * now takes an optional action, so the surface that shows it can hand the user
 * a real retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type App, type Plugin } from 'vue';
import ErrorAlert from '../components/ui/ErrorAlert.vue';
import { createUiI18n, mountUi, type MountedUi } from './i18n';

/** `UiButton` is an app-level global; the layer test only needs a marker. */
const ButtonStub = defineComponent({
	name: 'UiButton',
	emits: ['click'],
	setup:
		(_, { slots, emit }) =>
		() =>
			h('button', { 'data-stub': 'ui-button', onClick: () => emit('click') }, slots['default']?.()),
});

const uiEnvironment: Plugin = {
	install(app: App) {
		app.use(createUiI18n('en'));
		app.component('UiButton', ButtonStub);
	},
};

let mounted: MountedUi | null = null;

function mountAlert(props: Record<string, unknown>): HTMLElement {
	mounted = mountUi(ErrorAlert, props, 'en', uiEnvironment);
	return mounted.el;
}

afterEach(() => {
	mounted?.unmount();
	mounted = null;
});

describe('UiErrorAlert action', () => {
	it('renders no button without an action label', () => {
		const el = mountAlert({ message: 'Could not load senders.' });
		expect(el.querySelector('button')).toBeNull();
	});

	it('renders the action and emits it on click', () => {
		const onAction = vi.fn();
		const el = mountAlert({
			message: 'Could not load senders.',
			actionLabel: 'Try again',
			onAction,
		});

		const button = el.querySelector<HTMLButtonElement>('[data-stub="ui-button"]');
		expect(button?.textContent).toContain('Try again');

		button!.click();
		expect(onAction).toHaveBeenCalledTimes(1);
	});
});
