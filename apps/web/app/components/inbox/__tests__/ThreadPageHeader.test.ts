/**
 * The Team Inbox reader's header on a thread to the instance's `postmaster@` or
 * `abuse@`: it names the kind of mail and says why the thread has no contact
 * and no AI draft, so an admin does not go looking for either.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ThreadPageHeader from '../ThreadPageHeader.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import en from '~~/i18n/locales/en.json';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountHeader(systemMailbox?: 'postmaster' | 'abuse') {
	return mount(ThreadPageHeader, {
		props: {
			subject: 'Listing of 192.0.2.10',
			contact: null,
			messageCount: 1,
			priority: 'normal',
			presencePeople: [],
			...(systemMailbox ? { systemMailbox } : {}),
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiPageHeader: { template: '<div><slot name="title" /><slot name="meta" /></div>' },
				InboxThreadPresence: true,
			},
		},
	});
}

describe('ThreadPageHeader for postmaster and abuse mail', () => {
	it('names an abuse report and why it has no contact or AI draft', () => {
		const line = mountHeader('abuse').find('[data-testid="thread-system-mailbox"]');
		expect(line.text()).toContain('Abuse report');
		expect(line.text()).toContain(en.components.inbox.systemMailbox.explain);
	});

	it('names postmaster mail', () => {
		expect(
			mountHeader('postmaster').find('[data-testid="thread-system-mailbox"]').text()
		).toContain('Postmaster mail');
	});

	it('says nothing on a customer thread', () => {
		expect(mountHeader().find('[data-testid="thread-system-mailbox"]').exists()).toBe(false);
	});
});
