/**
 * The Coach panel's suggestion rows: a category label and its message read as
 * one sentence with a single space between them, and a suggestion with no
 * known category starts straight with its message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PostboxCoachPanel from '../PostboxCoachPanel.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const action = vi.fn();

beforeEach(() => {
	action.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('requireConvex', () => ({ action }));
});

/** Runs the coach over a draft and returns each suggestion row's exact text content. */
async function coach(suggestions: { category: string; message: string }[]) {
	action.mockResolvedValue({ suggestions });
	const wrapper = mount(PostboxCoachPanel, {
		props: {
			draftText: 'Hi Ines, you missed the deadline again, so delivery moves.',
			enabled: true,
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, UiButton: { template: '<button><slot /></button>' } },
		},
	});
	await wrapper.find('[data-testid="postbox-coach-run"]').trigger('click');
	await flushPromises();
	return wrapper
		.findAll('[data-testid="postbox-coach"] li > span:last-child')
		.map((row) => row.element.textContent);
}

describe('PostboxCoachPanel', () => {
	it('keeps one space between a category and its message', async () => {
		expect(
			await coach([
				{ category: 'tone', message: 'Soften the opening.' },
				{ category: 'missing-answer', message: 'Say whether the invoice can be split.' },
			])
		).toEqual([
			'Tone: Soften the opening.',
			'Missing answer: Say whether the invoice can be split.',
		]);
	});

	it('starts an uncategorised suggestion with its message, no leading space', async () => {
		expect(await coach([{ category: 'other', message: 'Shorten it.' }])).toEqual(['Shorten it.']);
	});
});
