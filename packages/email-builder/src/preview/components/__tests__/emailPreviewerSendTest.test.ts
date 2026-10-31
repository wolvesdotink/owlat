// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import EmailPreviewer from '../EmailPreviewer.vue';

/**
 * Send Test says what it does in a tooltip that keyboard focus opens too, and
 * shows only when the host offers test sends.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const mountPreviewer = (props: Record<string, unknown> = {}) => {
	wrapper = mount(EmailPreviewer, {
		props: {
			html: '<html><body><p>Hi</p></body></html>',
			autoAnalyze: false,
			showDeviceControls: false,
			...props,
		},
		attachTo: document.body,
	});
	return wrapper;
};

const sendTest = (w: VueWrapper) => w.findAll('button').find((b) => b.text() === 'Send Test');

describe('EmailPreviewer — Send Test', () => {
	it('opens its tooltip on keyboard focus and still sends', async () => {
		const w = mountPreviewer({ showSendTest: true });
		const button = sendTest(w)!;

		expect(button.attributes('title')).toBeUndefined();
		(button.element as HTMLElement).focus();
		await nextTick();
		expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Send test email');

		await button.trigger('click');
		expect(w.emitted('send-test')).toHaveLength(1);
	});

	it('is not offered unless the host asks for it', () => {
		const w = mountPreviewer();
		expect(sendTest(w)).toBeUndefined();
	});
});
