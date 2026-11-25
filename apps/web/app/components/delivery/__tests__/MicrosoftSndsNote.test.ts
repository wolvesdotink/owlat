/**
 * The Deliverability Center's note on what Microsoft SNDS says about the
 * sending addresses. The local stack has no SNDS feed, so this suite is the
 * proof of the red, yellow and spam-trap states.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

import MicrosoftSndsNote from '../MicrosoftSndsNote.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, i18nStubs);

const DAY = Date.UTC(2026, 10, 13);

function mountNote(
	standings: Array<{ ip: string; filterResult: 'red' | 'yellow'; periodStart: number }>,
	trapHits: Array<{ ip: string; trapHits: number; periodStart: number }> = []
) {
	return mount(MicrosoftSndsNote, {
		props: { standings, trapHits },
		global: { plugins: [createTestI18n()] },
	});
}

describe('MicrosoftSndsNote', () => {
	it('renders nothing while SNDS reports no address red or yellow', () => {
		expect(mountNote([]).find('[data-testid="microsoft-snds-note"]').exists()).toBe(false);
	});

	it('says a red address sends Microsoft mail at a reduced rate, and nothing else is held', () => {
		const note = mountNote([{ ip: '203.0.113.10', filterResult: 'red', periodStart: DAY }]).find(
			'[data-testid="microsoft-snds-note"]'
		);
		expect(note.text()).toContain('203.0.113.10');
		expect(note.text()).toContain('reduced rate');
		expect(note.text()).toContain('Other addresses and providers are not affected');
		expect(note.find('a').attributes('href')).toContain(
			'external-reputation-feedback#when-snds-reports-an-address-red'
		);
	});

	it('warns about a yellow address without claiming anything is held', () => {
		const note = mountNote([{ ip: '203.0.113.11', filterResult: 'yellow', periodStart: DAY }]).find(
			'[data-testid="microsoft-snds-note"]'
		);
		expect(note.text()).toContain('203.0.113.11');
		expect(note.text()).toContain('Nothing is held back');
		expect(note.text()).not.toContain('reduced rate');
	});

	it('names trap hits on a green address as their own finding, with list hygiene as the fix', () => {
		const note = mountNote([], [{ ip: '203.0.113.12', trapHits: 3, periodStart: DAY }]).find(
			'[data-testid="microsoft-snds-note"]'
		);
		expect(note.text()).toContain('SNDS counted 3 spam-trap hits for 203.0.113.12');
		expect(note.text()).toContain('Waiting does not fix this');
		expect(note.text()).not.toContain('reduced rate');
		const links = note.findAll('a').map((link) => link.attributes('href'));
		expect(links).toEqual([
			'https://docs.owlat.app/developer/external-reputation-feedback#when-snds-counts-spam-trap-hits',
		]);
	});

	it('puts the trap hits under the filter result of the same address', () => {
		const note = mountNote(
			[{ ip: '203.0.113.10', filterResult: 'red', periodStart: DAY }],
			[
				{ ip: '203.0.113.10', trapHits: 1, periodStart: DAY },
				{ ip: '198.51.100.4', trapHits: 2, periodStart: DAY },
			]
		).find('[data-testid="microsoft-snds-note"]');
		expect(note.findAll('p').map((line) => line.text().split(' ').slice(0, 5).join(' '))).toEqual([
			'SNDS counted 2 spam-trap hits',
			'SNDS rates 203.0.113.10 red for',
			'SNDS counted 1 spam-trap hit',
		]);
		expect(note.findAll('a')).toHaveLength(2);
	});
});
