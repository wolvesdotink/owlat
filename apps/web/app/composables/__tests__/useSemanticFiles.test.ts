/**
 * The Files page reads compact cards (`files.cards.list` / `search`),
 * not the legacy whole-row `semanticFiles.list` / `search` that carry each
 * file's embedding vectors and extracted text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { useSemanticFiles } from '../useSemanticFiles';

/** Every paginated subscription: its function name and current args. */
let opened: Array<{ name: string; args: () => unknown }>;
let query: ReturnType<typeof ref<string>>;

beforeEach(() => {
	opened = [];
	query = ref('');
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useDebouncedSearch', () => ({ query, debouncedQuery: query }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('usePaginatedQuery', (fn: unknown, args: () => unknown) => {
		opened.push({ name: getFunctionName(fn as never), args });
		return {
			results: ref([]),
			status: ref('Exhausted'),
			isLoading: ref(false),
			error: ref(null),
			refetch: vi.fn(),
			loadMore: vi.fn(),
		};
	});
});

const live = () => opened.filter((sub) => sub.args() !== 'skip').map((sub) => sub.name);

describe('useSemanticFiles', () => {
	it('lists and searches Files through the compact card queries', async () => {
		const scope = effectScope();
		scope.run(() => useSemanticFiles());

		expect(opened.map((sub) => sub.name)).toEqual([
			getFunctionName(api.files.cards.list),
			getFunctionName(api.files.cards.search),
		]);
		expect(live()).toEqual([getFunctionName(api.files.cards.list)]);

		query.value = 'invoice';
		await nextTick();
		expect(live()).toEqual([getFunctionName(api.files.cards.search)]);
		scope.stop();
	});
});
