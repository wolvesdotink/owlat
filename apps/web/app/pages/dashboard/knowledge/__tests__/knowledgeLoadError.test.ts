// @vitest-environment happy-dom
/**
 * A failed knowledge-base read is not an empty knowledge base (#721): the page
 * shows the error with a working Try again, never "No entries yet".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

import KnowledgeIndex from '../index.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import {
	ENTRY_TYPES,
	TYPE_CONFIG,
	entryTypeIcon,
	entryTypeVariant,
} from '~/utils/knowledgeEntryTypes';

let entriesError: Error | null;
let refetchEntries: ReturnType<typeof vi.fn>;

beforeEach(() => {
	entriesError = null;
	refetchEntries = vi.fn();
});

function render(): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		useConvexQuery: () => queryResult([]),
		useKnowledgeGraph: () => ({
			searchQuery: ref(''),
			selectedType: ref(null),
			entries: ref([]),
			isLoading: ref(false),
			error: ref(entriesError),
			refetch: refetchEntries,
			ENTRY_TYPES,
			TYPE_CONFIG,
			typeVariant: entryTypeVariant,
			typeIcon: entryTypeIcon,
		}),
	});
	return mount(KnowledgeIndex, {
		global: {
			plugins: [createTestI18n()],
			components: { UiQueryBoundary: QueryBoundary },
			stubs: {
				Icon: true,
				NuxtLink: { template: '<a><slot /></a>' },
				Teleport: true,
				UiInput: true,
				UiTextarea: true,
				UiSpinner: true,
				UiEmptyState: true,
				KnowledgeEntryCard: true,
				KnowledgeEntryForm: true,
				UiErrorAlert: { props: ['title'], template: '<p data-stub="error">{{ title }}</p>' },
				UiButton: {
					emits: ['click'],
					template: '<button data-stub="button" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
}

describe('knowledge base read state', () => {
	it('shows the empty state when there are no entries', () => {
		const wrapper = render();

		expect(wrapper.text()).toContain('No entries yet');
		expect(wrapper.find('[data-stub="error"]').exists()).toBe(false);
	});

	it('shows a failed read with Try again instead of the empty state (#721)', async () => {
		entriesError = new Error('[CONVEX Q(knowledge/graph:listAll)] [Request ID: 1] Server Error');
		const wrapper = render();

		expect(wrapper.text()).not.toContain('No entries yet');
		expect(wrapper.find('[data-stub="error"]').text()).toBe("Couldn't load the knowledge base");
		const retry = wrapper.findAll('[data-stub="button"]').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetchEntries).toHaveBeenCalledTimes(1);
	});
});
