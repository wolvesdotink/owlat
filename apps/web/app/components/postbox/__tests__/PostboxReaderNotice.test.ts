/**
 * The calm reader's notice slot (read on arrival §3): it renders the one
 * banner it is given. Danger is said here at thread level; the key change
 * comes through its slot; the left draft is the Answer-mode bar; image consent
 * stays in place inside the latest message, so the slot renders nothing.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxReaderNotice from '../PostboxReaderNotice.vue';
import type { ReaderNoticeKind } from '~/utils/postboxReaderNotice';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function mountNotice(kind: ReaderNoticeKind | null, extra: Record<string, unknown> = {}) {
	return mount(PostboxReaderNotice, {
		props: { kind, ...extra },
		slots: { keyChange: '<div data-testid="key-change">key changed</div>' },
		global: {
			plugins: [createTestI18n()],
			stubs: { PostboxAnswerDraftBar: { template: '<div data-testid="left-draft" />' } },
		},
	});
}

describe('PostboxReaderNotice', () => {
	it("says a spam verdict, or the DMARC failure in the trust chip's words", () => {
		expect(mountNotice('danger', { danger: 'spam' }).get('[role="alert"]').text()).toContain(
			'spam'
		);
		expect(
			mountNotice('danger', { danger: 'dmarc', dangerText: 'Failed sender check' })
				.get('[data-testid="reader-notice-danger"]')
				.text()
		).toBe('Failed sender check');
	});

	it('renders the key-change banner and the left draft through the one slot', () => {
		const key = mountNotice('keyChange');
		expect(key.find('[data-testid="key-change"]').exists()).toBe(true);
		expect(key.find('[data-testid="left-draft"]').exists()).toBe(false);
		const draft = mountNotice('leftDraft');
		expect(draft.find('[data-testid="left-draft"]').exists()).toBe(true);
		expect(draft.find('[data-testid="key-change"]').exists()).toBe(false);
		expect(draft.get('[data-reader-chrome="notice"]').attributes('data-notice')).toBe('leftDraft');
	});

	it('leaves image consent to the latest message, and renders nothing without a notice', () => {
		expect(mountNotice('images').find('[data-reader-chrome]').exists()).toBe(false);
		expect(mountNotice(null).find('[data-reader-chrome]').exists()).toBe(false);
	});
});
