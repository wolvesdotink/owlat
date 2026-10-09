// @vitest-environment happy-dom
/**
 * A held change under a personal brief item (interpret round 6): a later
 * message may have settled the item. It says so, keeps its source marker,
 * and Confirm applies it; a value change still reads "Check this change".
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BriefPendingUpdate from '../BriefPendingUpdate.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { evidence, T0 } from '~/utils/__tests__/threadBriefFixtures';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountUpdate(update: Record<string, unknown>) {
	return mount(BriefPendingUpdate, {
		props: { itemId: 'i1', update: update as never, canConfirm: true },
		global: { plugins: [createTestI18n()] },
	});
}

describe('BriefPendingUpdate', () => {
	it('says a later message may have settled the item, with its marker and Confirm', async () => {
		const w = mountUpdate({
			evidence: [evidence('m6', 'paid it yesterday')],
			transitions: [{ to: 'done', at: T0 }],
		});
		expect(w.get('[data-testid="brief-item-pending-settled"]').text()).toBe(
			'A later message may have settled this'
		);
		expect(w.find('[data-testid="evidence-marker"]').exists()).toBe(true);
		const confirm = w.get('[data-testid="brief-item-pending-confirm"]');
		expect(confirm.text()).toBe('Confirm');
		await confirm.trigger('click');
		expect(w.emitted('confirm')).toHaveLength(1);
		expectFullyLocalized(w);
	});

	it('keeps "Check this change" for a value change', () => {
		const w = mountUpdate({ evidence: [], amount: { value: 120, currency: 'EUR' } });
		expect(w.text()).toContain('Check this change:');
		expect(w.find('[data-testid="brief-item-pending-settled"]').exists()).toBe(false);
		expect(w.get('[data-testid="brief-item-pending-confirm"]').text()).toBe('Confirm change');
	});
});
