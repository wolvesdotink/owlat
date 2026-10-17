// @vitest-environment happy-dom
/**
 * Plain-language rules (read on arrival, SPEC §6.1, §6.2): a rule reads as a
 * line of chips with its folder and label names resolved, and the dry run
 * says where each match came from, including mail it could not test.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Id } from '@owlat/api/dataModel';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxRuleChips from '../PostboxRuleChips.vue';
import PostboxRuleDryRun from '../PostboxRuleDryRun.vue';
import { isPlainLanguageRule } from '~/composables/postbox/usePostboxRules';

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

const FINANCE = 'folder-finance' as Id<'mailFolders'>;

describe('PostboxRuleChips', () => {
	it('reads conditions, the AI question and the actions', () => {
		const wrapper = mount(PostboxRuleChips, {
			props: {
				conditions: [{ field: 'from', op: 'contains', value: 'supplier.example' }],
				matchType: 'any',
				aiQuestion: 'Is this an invoice?',
				actions: [
					{ type: 'moveToFolder', folderId: FINANCE },
					{ type: 'archiveAfter', hours: 24 },
					{ type: 'notify' },
				],
				folderName: (id: Id<'mailFolders'>) => (id === FINANCE ? 'Finance' : undefined),
				labelName: () => undefined,
			},
			global: { plugins: [createTestI18n()] },
		});
		const text = wrapper.text();
		expect(text).toContain('supplier.example');
		expect(text).toContain('AI: Is this an invoice?');
		expect(text).toContain('Move to Finance');
		expect(text).toContain('Archive after 24 h');
		expect(text).toContain('Notify me');
	});
});

describe('PostboxRuleDryRun', () => {
	it('lists matches with their source and says what was not tested', () => {
		const row = (subject: string, source: string, isMatch: boolean) => ({
			messageId: `m-${subject}` as Id<'mailMessages'>,
			fromAddress: 'billing@supplier.example',
			subject,
			receivedAt: Date.now(),
			isMatch,
			source,
		});
		const wrapper = mount(PostboxRuleDryRun, {
			props: {
				result: {
					rows: [
						row('Invoice 2026-311', 'ai_yes', true),
						row('Revised quote', 'ai_no', false),
						row('Your code', 'not_tested', false),
						row('Lunch', 'no_match', false),
					],
					scanned: 4,
					matchCount: 1,
					isAiUnavailable: false,
				},
			},
			global: { plugins: [createTestI18n()], stubs: { UiButton: true } },
		} as never);
		const text = wrapper.text();
		expect(text).toContain('Dry run · last 4 mails');
		expect(text).toContain('1 of 4 match');
		expect(text).toContain('AI · yes');
		expect(text).toContain('AI · no');
		expect(text).toContain('not tested');
		expect(text).not.toContain('Lunch');
	});
});

describe('isPlainLanguageRule', () => {
	it('is any non-manual origin or an AI condition', () => {
		expect(isPlainLanguageRule({})).toBe(false);
		expect(isPlainLanguageRule({ origin: 'manual' })).toBe(false);
		expect(isPlainLanguageRule({ origin: 'plain_language' })).toBe(true);
		expect(isPlainLanguageRule({ origin: 'fix' })).toBe(true);
		expect(isPlainLanguageRule({ aiCondition: { question: 'Invoice?' } })).toBe(true);
	});
});
