// @vitest-environment happy-dom
/**
 * The failed-message notice says what Retry will do (#1220): a failed send of
 * a reply a person approved is sent again and shows the text that goes out, a
 * person's reply goes back to review, and only an untouched message has the
 * agent draft again. Same rule as the server (`@owlat/shared/inboxRetry`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import InboxFailedNotice from '../InboxFailedNotice.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const APPROVED = 'Hi Jonas, I sent the refund of 42 EUR today.';

function mountNotice(message: Record<string, unknown>) {
	return mount(InboxFailedNotice, {
		props: { message, retrying: false },
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('InboxFailedNotice', () => {
	it('offers to send a failed approved reply again, showing its text', async () => {
		const wrapper = mountNotice({
			failedStage: 'send',
			approvalSource: 'human',
			draftResponse: APPROVED,
			errorMessage: 'Sending is disabled while this instance is suspended.',
		});
		expect(wrapper.text()).toContain('Sending failed');
		expect(wrapper.text()).toContain('Send again');
		expect(wrapper.text()).toContain('The agent does not write a new draft');
		expect(wrapper.find('[data-testid="thread-failed-reply"]').text()).toBe(APPROVED);
		expectFullyLocalized(wrapper);

		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('retry')).toHaveLength(1);
	});

	it('returns a person’s reply to review', () => {
		const wrapper = mountNotice({
			failedStage: 'pipeline',
			draftSavedAt: 1,
			draftResponse: APPROVED,
		});
		expect(wrapper.text()).toContain('Processing failed');
		expect(wrapper.text()).toContain('Back to review');
		expectFullyLocalized(wrapper);
	});

	it('has the agent draft again when nobody touched the reply', () => {
		const wrapper = mountNotice({ failedStage: 'pipeline', draftResponse: 'agent text' });
		expect(wrapper.text()).toContain('Retry processing');
		expect(wrapper.text()).toContain('writes a new draft');
		expect(wrapper.find('[data-testid="thread-failed-reply"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});
});
