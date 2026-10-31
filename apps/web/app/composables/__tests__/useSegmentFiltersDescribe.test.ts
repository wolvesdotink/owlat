import { describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';

const i18n = createTestI18n();
vi.stubGlobal('useI18n', () => i18n.global);
vi.mock('../conditions', () => ({
	CONDITION_EDITOR_MODULES: {},
	conditionEditorModuleFor: vi.fn(),
	provideConditionEditorContext: vi.fn(),
}));

const { useSegmentFilters } = await import('../useSegmentFilters');

function describeFilters(
	filters: Parameters<ReturnType<typeof useSegmentFilters>['describeFilters']>[0]
) {
	return useSegmentFilters({} as never).describeFilters(filters);
}

const t = i18n.global.t;
const INVALID = t('shared.useSegmentFilters.invalidFilters');
const ALL = t('shared.useSegmentFilters.allContacts');

describe('useSegmentFilters describeFilters', () => {
	it('describes stored filters by their conditions and logic', () => {
		const stored = JSON.stringify({
			logic: 'AND',
			conditions: [{ kind: 'topic_membership' }, { kind: 'property', extra: 1 }],
		});
		expect(describeFilters(stored)).toBe(
			t(
				'shared.useSegmentFilters.conditionSummary',
				{ count: 2, logic: t('shared.useSegmentFilters.logicAll') },
				2
			)
		);
	});

	it('describes stored filters without conditions as all contacts', () => {
		expect(describeFilters('{"logic":"OR","conditions":[]}')).toBe(ALL);
		expect(describeFilters('{}')).toBe(ALL);
	});

	it.each([
		['not JSON', '{logic'],
		['a list', '[]'],
		['null', 'null'],
		['conditions that are not a list', '{"logic":"AND","conditions":{"kind":"x"}}'],
		['a condition without a kind', '{"logic":"AND","conditions":[{}]}'],
		['a condition that is not an object', '{"logic":"AND","conditions":["topic"]}'],
		['an unknown logic', '{"logic":"XOR","conditions":[]}'],
	])('describes stored filters that are %s as invalid', (_case, stored) => {
		expect(describeFilters(stored)).toBe(INVALID);
	});
});
