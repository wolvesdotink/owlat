// @vitest-environment happy-dom
/**
 * A list row with a brief shows its top item instead of the snippet, and the
 * due date is set apart from the item's text ("Approve the quote by Fri",
 * never "quoteby Fri").
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxThreadRowBody from '../PostboxThreadRowBody.vue';

vi.mock('~/composables/postbox/usePostboxListClock', () => ({
	usePostboxThreadTimestamp: () => () => '09:12',
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (text: string) => text }));

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const DUE = Date.UTC(2026, 9, 21, 12);

function mountRow(top: Record<string, unknown>) {
	return mount(PostboxThreadRowBody, {
		props: {
			msg: {
				_id: 'm1',
				fromAddress: 'ana@example.com',
				subject: 'Quote',
				snippet: 'raw snippet',
				receivedAt: DUE - 86_400_000,
				flagSeen: true,
				flagFlagged: false,
				briefTop: {
					mode: 'brief',
					forYou: 1,
					waiting: 0,
					isReplyNeeded: false,
					top: {
						itemId: 'i1',
						bucket: 'forUs',
						responsibility: 'us',
						text: { en: 'Approve the revised quote', de: 'Angebot freigeben' },
						...top,
					},
				},
			} as never,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				PostboxRowCore: { template: '<div><slot /></div>' },
				PostboxThreadRowFollowUp: true,
				Icon: true,
			},
		},
	});
}

describe('PostboxThreadRowBody brief line', () => {
	it('sets the due date apart from the item text', () => {
		const line = mountRow({ dueAt: DUE }).get('[data-testid="row-brief-line"]').text();
		expect(line).toMatch(/Approve the revised quote by \S/);
		expect(line).not.toContain('quoteby');
	});

	it('shows the item alone when it has no due date', () => {
		const line = mountRow({}).get('[data-testid="row-brief-line"]').text();
		expect(line).toContain('Approve the revised quote');
		expect(line).not.toContain('raw snippet');
	});
});
