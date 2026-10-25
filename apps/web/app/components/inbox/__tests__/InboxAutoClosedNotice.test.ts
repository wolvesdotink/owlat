/**
 * The notice over a thread the auto-close sweep resolved: it says so, with the
 * days when the rule still has them, and offers Reopen to those who may.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import InboxAutoClosedNotice from '../InboxAutoClosedNotice.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const DAY = 24 * 60 * 60 * 1000;

function mountNotice(props: Record<string, unknown> = {}) {
	return mount(InboxAutoClosedNotice, {
		props: { autoClosedAt: Date.now() - 2 * DAY, quietDays: 7, canReopen: true, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: {
					emits: ['click'],
					template: '<button @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

describe('InboxAutoClosedNotice', () => {
	it('says it closed automatically and after how many quiet days', () => {
		const text = mountNotice().text();
		expect(text).toContain('Closed automatically 2 days ago');
		expect(text).toContain('after 7 quiet days waiting on the customer');
		expect(mountNotice({ quietDays: 1 }).text()).toContain('after 1 quiet day waiting');
		expect(mountNotice({ quietDays: null }).text()).toContain('after a quiet period');
	});

	it('reopens on request, and offers it only to those who may', async () => {
		const wrapper = mountNotice();
		await wrapper.get('[data-testid="thread-auto-closed-reopen"]').trigger('click');
		expect(wrapper.emitted('reopen')).toHaveLength(1);
		expect(
			mountNotice({ canReopen: false }).find('[data-testid="thread-auto-closed-reopen"]').exists()
		).toBe(false);
	});
});
