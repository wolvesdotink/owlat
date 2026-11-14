/**
 * A soft-bounce row says that it expires and when, the same rule the send paths
 * apply, so a lapsed row is not read as a live block. Hard bounces, complaints
 * and manual blocks never expire and say nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { SOFT_BOUNCE_SUPPRESSION_TTL_MS } from '@owlat/shared/softBounceSuppression';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { queryResult } from '~/__tests__/queryStubs';
import SuppressionsTable from '../SuppressionsTable.vue';

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useOrganizationQuery', () => queryResult([]));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function row(id: string, fields: Record<string, unknown>) {
	return { _id: id, _creationTime: 0, email: `${id}@example.com`, ...fields };
}

describe('SuppressionsTable soft-bounce expiry', () => {
	it('says when a soft bounce expires, that a lapsed one no longer blocks, and nothing for a hard bounce', () => {
		const w = mount(SuppressionsTable, {
			props: {
				rows: [
					row('fresh', { reason: 'bounced', bounceType: 'soft', createdAt: NOW - 1000 }),
					row('lapsed', {
						reason: 'bounced',
						bounceType: 'soft',
						createdAt: NOW - SOFT_BOUNCE_SUPPRESSION_TTL_MS - 1000,
					}),
					row('gone', { reason: 'bounced', bounceType: 'hard', createdAt: NOW - 1000 }),
				] as never,
				canManage: false,
			},
			global: { plugins: [createTestI18n()], stubs: { UiTooltip: true, UiButton: true } },
		});

		const lines = w.findAll('tbody tr').map((tr) => tr.find('[data-testid="suppression-expiry"]'));
		expect(lines[0]!.text()).toContain('expires');
		expect(lines[1]!.text()).toContain('no longer blocks');
		expect(lines[2]!.exists()).toBe(false);
		w.unmount();
	});
});
