import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { usePersonalizationVariables } from '../usePersonalizationVariables';

const i18n = createTestI18n();

describe('usePersonalizationVariables', () => {
	const properties = ref<Array<{ key: string; label: string }> | undefined>(undefined);

	beforeEach(() => {
		properties.value = undefined;
		vi.stubGlobal('useI18n', () => i18n.global);
		vi.stubGlobal('useOrganizationQuery', () => ({ data: properties, isLoading: ref(false) }));
	});

	it('offers the built-in contact fields before the properties load', () => {
		const variables = usePersonalizationVariables();
		expect(variables.value).toEqual([
			{ key: 'email', label: 'Email', isBuiltIn: true },
			{ key: 'firstName', label: 'First name', isBuiltIn: true },
			{ key: 'lastName', label: 'Last name', isBuiltIn: true },
		]);
	});

	it('appends custom properties and skips the ones a built-in already covers', () => {
		const variables = usePersonalizationVariables();
		properties.value = [
			{ key: 'first_name', label: 'First name' },
			{ key: 'company', label: 'Company' },
			{ key: 'last_name', label: 'Last name' },
			{ key: 'plan', label: 'Plan' },
		];
		expect(variables.value.map((v) => [v.key, v.isBuiltIn])).toEqual([
			['email', true],
			['firstName', true],
			['lastName', true],
			['company', false],
			['plan', false],
		]);
		expect(variables.value[3]?.label).toBe('Company');
	});
});
