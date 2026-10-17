// @vitest-environment happy-dom
/**
 * The calm reader's strip (read on arrival §3), one case per state: the brief
 * strip (lead, the item you owe with Reply and Done, the item you wait on, the
 * meta row), the gist line with its sender, and the slim "Why here? · Details"
 * line, with the quiet "reading" note that replaced the skeleton.
 */
import { describe, expect, it, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxReaderStrip from '../PostboxReaderStrip.vue';
import PostboxReaderStripLinks from '../PostboxReaderStripLinks.vue';
import type { ReaderStrip } from '~/utils/postboxReaderStrip';
import { item } from '~/utils/__tests__/threadBriefFixtures';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const owe = item({ id: 'i_quote', text: 'Send the signed quote' });
const waiting = item({
	id: 'i_sample',
	text: 'final paper sample',
	responsibility: 'them',
	responsible: { isUs: false, name: 'Lena' },
});

function mountStrip(strip: ReaderStrip, extra: Record<string, unknown> = {}) {
	return mount(PostboxReaderStrip, {
		props: {
			strip,
			gistAttribution: 'DHL',
			detailsOpen: false,
			showWhyHere: true,
			...extra,
		},
		slots: { details: '<p data-testid="details-content">trust chip</p>' },
		global: {
			plugins: [createTestI18n()],
			components: { PostboxReaderStripLinks },
			stubs: { transition: false },
		},
	});
}

describe('PostboxReaderStrip', () => {
	it('shows the lead, the item you owe and the item you wait on, then the meta row', async () => {
		const w = mountStrip(
			{ kind: 'brief', lead: { kind: 'latest', text: 'Lena moved delivery.' }, owe, waiting },
			{ summary: 'signed · images off', hasFullBrief: true }
		);
		expect(w.get('[data-testid="strip-lead"]').text()).toBe('Lena moved delivery.');
		expect(w.get('[data-testid="strip-owe"]').text()).toContain('Send the signed quote');
		expect(w.get('[data-testid="strip-waiting"]').text()).toBe(
			'Waiting on Lena: final paper sample'
		);
		const meta = w.get('[data-testid="strip-meta"]').text();
		expect(meta).toContain('Full brief');
		expect(meta).toContain('Why here?');
		expect(meta).toContain('Details');
		expect(w.get('[data-testid="strip-summary"]').text()).toBe('signed · images off');

		expect(w.get('[data-testid="strip-owe-reply"]').text()).toBe('Reply');
		expect(w.get('[data-testid="strip-owe-markDone"]').text()).toBe('Mark done');
		await w.get('[data-testid="strip-owe-reply"]').trigger('click');
		await w.get('[data-testid="strip-owe-markDone"]').trigger('click');
		expect(w.emitted('react')).toEqual([
			[owe, 'reply'],
			[owe, 'markDone'],
		]);
		await w.get('[data-testid="strip-full-brief"]').trigger('click');
		expect(w.emitted('full-brief')).toHaveLength(1);
	});

	it('quotes gist spans verbatim with the sender', () => {
		const w = mountStrip({
			kind: 'gist',
			gist: { quotes: ['Parcel delivered to the neighbour', 'at no. 14'] },
		});
		const line = w.get('[data-testid="strip-gist"]');
		expect(line.find('q').text()).toBe('Parcel delivered to the neighbour … at no. 14');
		expect(line.text()).toContain('— DHL');
		// A gist line is the whole strip: no items, no Full brief.
		expect(w.find('[data-testid="strip-owe"]').exists()).toBe(false);
		expect(w.find('[data-testid="strip-full-brief"]').exists()).toBe(false);
		expect(w.find('[data-testid="strip-why-here"]').exists()).toBe(true);
	});

	it('stands in with the slim "Why here? · Details" line when there is no strip', () => {
		const w = mountStrip({ kind: 'meta', note: null });
		expect(w.find('[data-testid="reader-strip"]').exists()).toBe(false);
		expect(w.get('[data-testid="reader-meta-line"]').text()).toMatch(/^Why here\?\s*·\s*Details$/);
		expect(w.find('[data-testid="meta-reading"]').exists()).toBe(false);
		// No skeleton, ever.
		expect(w.html()).not.toMatch(/skeleton/i);
	});

	it('says quietly that this open reads the thread', () => {
		const w = mountStrip({ kind: 'meta', note: 'reading' });
		expect(w.get('[data-testid="meta-reading"]').text()).toBe('Reading this thread now');
	});

	it('hides Why here? where there is no arrival (a team inbox)', () => {
		const w = mountStrip({ kind: 'meta', note: null }, { showWhyHere: false });
		expect(w.find('[data-testid="strip-why-here"]').exists()).toBe(false);
	});

	it('emits Why here? with its link as the anchor', async () => {
		const w = mountStrip({ kind: 'meta', note: null });
		const link = w.get('[data-testid="strip-why-here"]');
		await link.trigger('click');
		expect(w.emitted('why-here')?.[0]?.[0]).toBe(link.element);
	});

	it('keeps Details collapsible and its panel mounted for the teleported chips', async () => {
		const w = mountStrip({ kind: 'meta', note: null });
		const panel = w.get('[data-testid="strip-details-panel"]');
		expect(panel.attributes('style')).toContain('display: none');
		expect(panel.find('[data-testid="details-content"]').exists()).toBe(true);
		await w.get('[data-testid="strip-details"]').trigger('click');
		expect(w.emitted('update:detailsOpen')).toEqual([[true]]);
		await w.setProps({ detailsOpen: true });
		expect(w.get('[data-testid="strip-details-panel"]').attributes('style') ?? '').not.toContain(
			'display: none'
		);
		expect((w.vm as unknown as { detailsEl: HTMLElement }).detailsEl).toBe(panel.element);
	});

	it('offers "Read the exact wording" when the brief lists such a message', async () => {
		const w = mountStrip({ kind: 'meta', note: null }, { hasExactWording: true });
		await w.get('[data-testid="strip-exact-wording"]').trigger('click');
		expect(w.emitted('exact-wording')).toHaveLength(1);
	});

	it('offers Full brief on the slim line too, whenever the brief holds anything', async () => {
		const w = mountStrip({ kind: 'meta', note: null }, { hasFullBrief: true });
		await w.get('[data-testid="strip-full-brief"]').trigger('click');
		expect(w.emitted('full-brief')).toHaveLength(1);
		expect(
			mountStrip({ kind: 'meta', note: null }).find('[data-testid="strip-full-brief"]').exists()
		).toBe(false);
	});

	it('keeps an unconfirmed proposal a "Check this" with Track and Not a request', async () => {
		const proposal = item({ id: 'i_prop', text: 'Pay the deposit', verify: 'proposal' });
		const w = mountStrip({ kind: 'brief', lead: null, owe: proposal, waiting: null });
		expect(w.get('[data-testid="strip-owe-text"]').text()).toBe('Check this: Pay the deposit');
		expect(w.find('[data-testid="strip-owe-reply"]').exists()).toBe(false);
		expect(w.find('[data-testid="strip-owe-markDone"]').exists()).toBe(false);
		expect(w.get('[data-testid="strip-owe-confirmProposal"]').text()).toBe('Track');
		await w.get('[data-testid="strip-owe-confirmProposal"]').trigger('click');
		await w.get('[data-testid="strip-owe-notARequest"]').trigger('click');
		expect(w.emitted('react')).toEqual([
			[proposal, 'confirmProposal'],
			[proposal, 'notARequest'],
		]);
		expect(w.get('[data-ring]').attributes('data-ring')).toBe('proposal');
	});

	it('trims a long gist to 160 characters at a word boundary', () => {
		const long = Array.from({ length: 50 }, (_, i) => `span${i}`).join(' ');
		const w = mountStrip({ kind: 'gist', gist: { quotes: [long] } });
		const quote = w.get('[data-testid="strip-gist"] q').text();
		expect(quote.length).toBeLessThanOrEqual(160);
		expect(quote.endsWith('…')).toBe(true);
	});
});
