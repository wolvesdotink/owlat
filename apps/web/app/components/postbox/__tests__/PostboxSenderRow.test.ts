/**
 * One Senders row (SPEC §5): the read bar, the kind, the status control and
 * the markers under the name. The row only emits; the panel runs the calls.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxSenderRow from '../PostboxSenderRow.vue';
import type { PostboxSenderRow as Row } from '~/utils/postboxSenders';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const segmentedStub = {
	props: ['modelValue', 'options'],
	emits: ['update:modelValue'],
	template:
		'<div class="segmented"><button v-for="o in options" :key="o.value" :data-value="o.value" :data-on="o.value === modelValue" @click="$emit(\'update:modelValue\', o.value)">{{ o.label }}</button></div>',
};

const base: Row = {
	senderDigest: 'd1',
	address: 'newsletter@manufactum.example',
	displayName: 'Manufactum',
	status: 'keep',
	statusSource: 'default',
	kind: 'newsletter',
	delivered: 38,
	opened: 2,
};

function mountRow(row: Partial<Row> = {}) {
	return mount(PostboxSenderRow, {
		props: { row: { ...base, ...row } },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiSegmentedControl: segmentedStub },
		},
		attachTo: document.createElement('tbody'),
	});
}

describe('PostboxSenderRow', () => {
	it('shows the sender, the volume, what was read and the kind', () => {
		const w = mountRow();
		expect(w.text()).toContain('Manufactum');
		expect(w.text()).toContain('newsletter@manufactum.example');
		expect(w.text()).toContain('38');
		expect(w.text()).toContain('Newsletter');
		expect(w.get('[role="img"]').attributes('aria-label')).toBe('5% read');
		expect(w.get('[data-on="true"]').attributes('data-value')).toBe('keep');
	});

	it('emits the chosen status, never the current one', async () => {
		const w = mountRow();
		await w.get('[data-value="keep"]').trigger('click');
		await w.get('[data-value="unsubscribed"]').trigger('click');
		expect(w.emitted('setStatus')).toEqual([['unsubscribed']]);
	});

	it('lets the person turn a suggestion down with an explicit Keep', async () => {
		// Keep is already the selected segment on a default profile, so the
		// control alone can never record "I chose Keep".
		const w = mountRow({ suggestion: 'digest' });
		await w.get('[data-testid="sender-keep-as-is"]').trigger('click');
		expect(w.emitted('setStatus')).toEqual([['keep']]);
		expect(mountRow().find('[data-testid="sender-keep-as-is"]').exists()).toBe(false);
	});

	it('shows the drafts-paused marker with Resume', async () => {
		const w = mountRow({ autoDraftPausedAt: 1 });
		expect(w.text()).toContain('Drafts paused');
		await w.get('button.text-brand').trigger('click');
		expect(w.emitted('resume')).toHaveLength(1);
	});

	it('says how an unsubscribe went, and what a suggestion would set', () => {
		const failed = mountRow({
			status: 'unsubscribed',
			unsubscribe: { method: 'one_click', requestedAt: 1, result: 'failed' },
		});
		expect(failed.text()).toContain("Couldn't unsubscribe; mail from them is archived");
		const suggested = mountRow({ suggestion: 'digest' });
		expect(suggested.text()).toContain('Suggested: Digest');
	});

	it('carries a phone line with volume and read rate, and orders the suggestion after the control there', () => {
		const w = mountRow({ suggestion: 'digest' });
		expect(w.get('[data-testid="sender-phone-stats"]').text()).toBe('38 mails · read 5%');
		expect(w.get('[data-testid="sender-phone-stats"]').classes()).toContain('md:hidden');
		// Below md the first cell dissolves into the card so its suggestion line
		// can sit after the full-width control; from md up it is a table cell.
		expect(w.get('td').classes()).toEqual(expect.arrayContaining(['contents', 'md:table-cell']));
		const suggestion = w.get('[data-testid="sender-keep-as-is"]').element.parentElement!;
		expect(suggestion.className).toContain('order-last');
		expect(suggestion.className).toContain('md:order-none');
		expect(
			mountRow({ delivered: 1, opened: 1 }).get('[data-testid="sender-phone-stats"]').text()
		).toBe('1 mail · read 100%');
	});
});
