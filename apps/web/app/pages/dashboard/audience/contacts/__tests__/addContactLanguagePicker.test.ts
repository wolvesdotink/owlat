// @vitest-environment happy-dom
/**
 * The add-contact modal's language picker.
 *
 * `~/data/languageOptions` is module scope, so its `label` is a MESSAGE KEY.
 * The modal once mapped the catalog straight into `UiSelect` options, painting
 * "shared.data.languageOptions.languages.de (Deutsch)" — and, for the unset
 * entry, the `notSetEmailDefault` keypath twice. The page now builds its pairs
 * through `languageSelectOptions(t)`, where a translator is in hand.
 *
 * The page mounts with its feature components left unresolved (Vue renders an
 * unresolved component as a plain element and still renders its default slot),
 * so this stays a picker test rather than a whole-page audit; only `UiSelect`
 * is stubbed, because that is where the labels under test land.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

import ContactsIndex from '../index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, paginatedResult, queryResult } from '~/__tests__/a11y';
import { useBulkOperation } from '~/composables/useBulkOperation';
import { useBulkSelection } from '~/composables/useBulkSelection';
import { useClickOutside } from '~/composables/useClickOutside';
import { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import { useCsvImport } from '~/composables/useCsvImport';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';

// The real UiSelect is a custom listbox that only paints its options once
// opened; a stub that renders them inline is what makes the labels assertable.
const selectStub = {
	props: ['modelValue', 'label', 'options', 'disabled', 'placeholder'],
	emits: ['update:modelValue'],
	template:
		'<select :aria-label="label"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>',
};

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		// Pure page composables run for real — the markup branches on them.
		useBulkOperation,
		useBulkSelection,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useContactBulkOperations,
		useCsvImport,
		useDataTable,
		useDebouncedSearch,
		useFormModal,
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
	});
});

function languageOptionTexts(): string[] {
	const wrapper = mount(ContactsIndex, {
		global: {
			plugins: [createTestI18n()],
			stubs: { UiSelect: selectStub },
			// Feature components are left unresolved on purpose; the resulting
			// warning storm would bury a real one.
			config: { warnHandler: () => {} },
		},
	});
	const picker = wrapper.find('select[aria-label="Preferred Language"]');
	expect(picker.exists()).toBe(true);
	return picker.findAll('option').map((o) => o.text());
}

describe('add-contact language picker', () => {
	it('renders translated language names, not catalog message keys', () => {
		const options = languageOptionTexts();

		expect(options[0]).toBe('Not set (use email default)');
		expect(options).toContain('German (Deutsch)');
		// English's endonym IS its English name, so it is not parenthesized.
		expect(options).toContain('English');
	});

	it('leaks no raw message keys into the picker', () => {
		for (const label of languageOptionTexts()) {
			expect(label).not.toMatch(/shared\.data\.languageOptions\./);
		}
	});
});
