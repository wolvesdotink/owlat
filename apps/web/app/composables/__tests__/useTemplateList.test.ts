// @vitest-environment happy-dom
/**
 * `useTemplateList` is what the marketing and transactional pages share on top
 * of `useListPage`: the query is built from the list's search and sort, a row
 * opens its editor, and the loading flag the shell reads never strands a user
 * without an organization on a spinner (the skipped query reports loading).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import type { TemplateSortOption } from '~/utils/templateListSort';

vi.mock('../useKeyboardShortcuts', () => ({
	useKeyboardShortcuts: () => ({
		registerNewShortcut: vi.fn(),
		registerEscapeHandler: vi.fn(),
		unregisterShortcut: vi.fn(),
	}),
}));

const { useTemplateList } = await import('../useTemplateList');

type Row = {
	_id: string;
	name: string;
	status: 'draft' | 'published';
	createdAt: number;
	updatedAt: number;
};

const push = vi.fn();
const organizationLoading = ref(false);
const hasOrganization = ref(true);

beforeEach(() => {
	push.mockClear();
	organizationLoading.value = false;
	hasOrganization.value = true;
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useRouter', () => ({ push }));
	vi.stubGlobal('useOrganizationContext', () => ({
		hasActiveOrganization: hasOrganization,
		isLoading: organizationLoading,
	}));
});

function setup() {
	const rows = ref<Row[] | undefined>(undefined);
	const queryLoading = ref(true);
	let seen: { search: Readonly<Ref<string>>; sort: Readonly<Ref<TemplateSortOption>> } | null =
		null;
	const { result } = withSetup(() =>
		useTemplateList<Row>({
			query: (state) => {
				seen = state;
				return { rows, isLoading: queryLoading, error: ref(null), refetch: vi.fn() };
			},
			editPath: (row) => `/edit/${row._id}`,
			onDelete: vi.fn(async () => true),
			onDuplicate: vi.fn(async () => {}),
			onNew: vi.fn(),
			canCreate: () => true,
		})
	);
	return { result, rows, queryLoading, seen: () => seen! };
}

const row: Row = { _id: 'r1', name: 'Welcome', status: 'draft', createdAt: 1, updatedAt: 2 };

describe('useTemplateList', () => {
	it('builds the query from the live search and sort', () => {
		const { result, seen } = setup();
		expect(seen().sort.value.value).toBe('updatedAt-desc');
		result.selectSort('name-asc');
		expect(seen().sort.value.value).toBe('name-asc');
		expect(seen().search).toBe(result.debouncedSearch);
	});

	it('loads until the first rows land, then keeps showing them', () => {
		const { result, rows, queryLoading } = setup();
		expect(result.isLoading.value).toBe(true);
		rows.value = [row];
		expect(result.isLoading.value).toBe(false);
		expect(result.items.value).toEqual([row]);
		expect(result.isEmpty.value).toBe(false);
		queryLoading.value = false;
		rows.value = [];
		expect(result.isEmpty.value).toBe(true);
	});

	it('does not spin forever without an organization', () => {
		hasOrganization.value = false;
		const { result } = setup();
		expect(result.isLoading.value).toBe(false);
		expect(result.hasOrganization.value).toBe(false);
		organizationLoading.value = true;
		expect(result.isLoading.value).toBe(true);
	});

	it('opens a row at its edit path and defaults to the list view', () => {
		const { result } = setup();
		result.handleEdit(row);
		expect(push).toHaveBeenCalledWith('/edit/r1');
		expect(result.viewMode.value).toBe('list');
	});
});
