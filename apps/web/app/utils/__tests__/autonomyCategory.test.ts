import { describe, expect, it } from 'vitest';
import { autonomyCategoryName } from '../autonomyCategory';
import { createTestI18n } from '~/__tests__/i18n';

const { t, te } = createTestI18n().global;

describe('autonomyCategoryName', () => {
	it('names a known category from the rule editor catalog', () => {
		const key = 'components.autonomy.autonomyRuleEditor.categories.feature_request';
		expect(te(key)).toBe(true);
		expect(autonomyCategoryName('feature_request', t, te)).toBe(t(key));
	});

	it('reads an unknown category as words, not as a key path', () => {
		expect(autonomyCategoryName('brand_new_kind', t, te)).toBe('brand new kind');
	});
});
