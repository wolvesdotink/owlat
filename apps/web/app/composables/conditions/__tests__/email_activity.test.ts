import { describe, it, expect } from 'vitest';
import { computed } from 'vue';
import { emailActivityEditorModule, ACTIVITY_OPTIONS } from '../email_activity';
import type { ConditionEditorContext } from '../types';
import { createTestI18n } from '~/__tests__/i18n';

/** The module carries catalog keys, so assertions render them in English. */
const { t } = createTestI18n().global;

const emptyCtx: ConditionEditorContext = {
	contactProperties: computed(() => []),
	topics: computed(() => []),
};

describe('emailActivityEditorModule', () => {
	it('createDefault returns a canonical email_activity condition', () => {
		expect(emailActivityEditorModule.createDefault(emptyCtx)).toEqual({
			kind: 'email_activity',
			field: 'opened',
			operator: 'is_true',
		});
	});

	describe('validateForSubmit', () => {
		it('passes for valid opened/clicked field', () => {
			for (const field of ['opened', 'clicked'] as const) {
				for (const operator of ['is_true', 'is_false'] as const) {
					expect(
						emailActivityEditorModule.validateForSubmit({
							kind: 'email_activity',
							field,
							operator,
						})
					).toBeNull();
				}
			}
		});

		it('flags an unknown field as missing activity type', () => {
			expect(
				t(
					emailActivityEditorModule.validateForSubmit({
						kind: 'email_activity',
						field: 'bounced' as never,
						operator: 'is_true',
					})!
				)
			).toBe('Please select an activity type');
		});
	});

	describe('getDescription', () => {
		it('matches each option label', () => {
			for (const option of ACTIVITY_OPTIONS) {
				expect(
					emailActivityEditorModule.getDescription(
						{ kind: 'email_activity', field: option.field, operator: option.operator },
						emptyCtx
					).key
				).toBe(option.label);
			}
		});

		it('renders the English copy of every option', () => {
			expect(ACTIVITY_OPTIONS.map((option) => t(option.label))).toEqual([
				'Has opened an email',
				'Has clicked a link',
				'Has not opened any email',
				'Has not clicked any link',
			]);
		});

		it('falls back when no matching option is found', () => {
			expect(
				t(
					emailActivityEditorModule.getDescription(
						{ kind: 'email_activity', field: 'unknown' as never, operator: 'is_true' },
						emptyCtx
					).key
				)
			).toBe('Configure email activity');
		});
	});

	it('ACTIVITY_OPTIONS covers both fields × both operators', () => {
		expect(ACTIVITY_OPTIONS).toHaveLength(4);
		const keys = new Set(ACTIVITY_OPTIONS.map((o) => `${o.field}:${o.operator}`));
		expect(keys).toEqual(
			new Set(['opened:is_true', 'clicked:is_true', 'opened:is_false', 'clicked:is_false'])
		);
	});
});
