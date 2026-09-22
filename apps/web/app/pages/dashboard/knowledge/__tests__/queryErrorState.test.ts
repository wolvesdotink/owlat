import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { ref } from 'vue';
import KnowledgePage from '../index.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const error = ref<Error | null>(null);
const errorMessage = ref<string>();
const retry = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	error.value = null;
	errorMessage.value = undefined;
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useKnowledgeGraph', () => ({
		searchQuery: ref(''),
		selectedType: ref(null),
		entries: ref([]),
		isLoading: ref(false),
		error,
		errorMessage,
		refetch: retry,
		ENTRY_TYPES: [],
		TYPE_CONFIG: {},
		typeVariant: vi.fn(),
		typeIcon: vi.fn(),
	}));
	vi.stubGlobal('useBackendQuery', () => ({
		data: ref([]),
		error: ref(null),
		errorMessage: ref(undefined),
		isLoading: ref(false),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => ({ isLoading: ref(false), run: vi.fn() }));
});

function mountPage() {
	return shallowMount(KnowledgePage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiSpinner: true,
				KnowledgeEntryCard: true,
				UiInput: true,
				UiTextarea: true,
				KnowledgeEntryForm: true,
				UiEmptyState: true,
				UiQueryBoundary: QueryBoundary,
				UiErrorAlert: { props: ['message'], template: '<p>{{ message }}</p>' },
				UiButton: { template: '<button><slot /></button>' },
			},
		},
	});
}

describe('Knowledge list query failure', () => {
	it('shows safe error copy and retries instead of offering to create a first entry', async () => {
		error.value = new Error('raw server implementation detail');
		errorMessage.value = 'You do not have permission to read knowledge entries.';
		const page = mountPage();
		expect(page.text()).toContain(errorMessage.value);
		expect(page.text()).not.toContain('raw server implementation detail');
		expect(page.text()).not.toContain('Create First Entry');
		const button = page.findAll('button').find((b) => b.text() === 'Try again');
		expect(button).toBeDefined();
		await button!.trigger('click');
		expect(retry).toHaveBeenCalledOnce();
		error.value = null;
		errorMessage.value = undefined;
		await page.vm.$nextTick();
		expect(page.text()).not.toContain('Try again');
		expect(page.text()).toContain('Create First Entry');
		page.unmount();
	});
});
