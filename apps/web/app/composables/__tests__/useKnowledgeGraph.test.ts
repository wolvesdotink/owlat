/**
 * useKnowledgeGraph reads through one of three queries (search, one type, or
 * all types). The error and refetch it hands the page must be the ones of the
 * query the current search / tab is actually using (#721): a failed search must
 * not hide behind a healthy "All" list, and Try again must retry the failed read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { queryResult } from '~/__tests__/queryStubs';
import { useKnowledgeGraph } from '../useKnowledgeGraph';

type Result = ReturnType<typeof queryResult<unknown[] | undefined>>;

let reads: Record<string, Result>;
let debouncedQuery: ReturnType<typeof ref<string>>;

beforeEach(() => {
	reads = {};
	debouncedQuery = ref('');
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key, locale: ref('en') }));
	vi.stubGlobal('useDebouncedSearch', () => ({ query: ref(''), debouncedQuery }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
	vi.stubGlobal('useConvexQuery', (reference: FunctionReference<'query'>) => {
		const result = queryResult<unknown[] | undefined>([]);
		reads[getFunctionName(reference)] = result;
		return result;
	});
});

const SEARCH = 'knowledge/graph:search';
const BY_TYPE = 'knowledge/graph:listByType';
const ALL = 'knowledge/graph:listAll';

function fail(name: string): Error {
	const error = new Error(`[CONVEX Q(${name})] Server Error`);
	reads[name]!.error.value = error as never;
	return error;
}

describe('useKnowledgeGraph read state', () => {
	it('reports the All list on the All tab', () => {
		const graph = useKnowledgeGraph();
		fail(BY_TYPE);
		fail(SEARCH);
		expect(graph.error.value).toBeNull();

		const error = fail(ALL);
		expect(graph.error.value).toBe(error);
		graph.refetch();
		expect(reads[ALL]!.refetch).toHaveBeenCalledTimes(1);
		expect(reads[BY_TYPE]!.refetch).not.toHaveBeenCalled();
	});

	it('follows the selected type', () => {
		const graph = useKnowledgeGraph();
		const error = fail(BY_TYPE);
		expect(graph.error.value).toBeNull();

		graph.selectedType.value = 'faq';
		expect(graph.error.value).toBe(error);
		graph.refetch();
		expect(reads[BY_TYPE]!.refetch).toHaveBeenCalledTimes(1);
		expect(reads[ALL]!.refetch).not.toHaveBeenCalled();
	});

	it('follows the search while one is active, on any tab', () => {
		const graph = useKnowledgeGraph();
		graph.selectedType.value = 'faq';
		const error = fail(SEARCH);
		expect(graph.error.value).toBeNull();

		debouncedQuery.value = 'refund';
		expect(graph.error.value).toBe(error);
		graph.refetch();
		expect(reads[SEARCH]!.refetch).toHaveBeenCalledTimes(1);
		expect(reads[BY_TYPE]!.refetch).not.toHaveBeenCalled();

		debouncedQuery.value = '';
		expect(graph.error.value).toBeNull();
	});
});
