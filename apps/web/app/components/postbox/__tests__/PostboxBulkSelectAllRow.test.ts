// @vitest-environment happy-dom
/**
 * The whole-folder select-all escape hatch, now in the bulk bar.
 *
 * It goes to the server rather than pretending the loaded page is the folder,
 * it is only offered once the page itself is covered (so it reads as "and the
 * rest"), and it is WITHHELD while a triage chip narrows the list below the
 * folder scope — under a chip it would hand the next bulk verb rows the user
 * never saw as selected.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import PostboxBulkSelectAllRow from '../PostboxBulkSelectAllRow.vue';
import { usePostboxBulkActions } from '~/composables/postbox/usePostboxBulkActions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stateBuckets: Map<string, any>;
const listMessageIds = vi.fn(async () => ({ ids: ['a', 'b', 'c'], capped: false }));

beforeAll(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

beforeEach(() => {
	stateBuckets = new Map();
	listMessageIds.mockClear();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(async () => ({ ok: true, result: {} })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({
		register: vi.fn(),
		registerMoveBack: vi.fn(),
	}));
	vi.stubGlobal('requireConvex', () => ({ query: listMessageIds }));
	// The real selection composable, over the stubbed state + mutation layers.
	vi.stubGlobal('usePostboxBulkActions', usePostboxBulkActions);
});

function mountRow(
	props: {
		folderRole?: string;
		sortOrder?: string;
		pageIds?: string[];
		scopeMatchesList?: boolean;
	} = {}
) {
	return mount(PostboxBulkSelectAllRow, {
		props: {
			mailboxId: 'mbx' as never,
			folderRole: props.folderRole ?? 'inbox',
			sortOrder: props.sortOrder,
			pageIds: props.pageIds ?? ['a', 'b', 'c'],
			scopeMatchesList: props.scopeMatchesList,
		},
		global: {
			plugins: [createTestI18n()],
			components: { Icon: { props: ['name'], template: '<span />' } },
		},
	});
}

/** Pick every loaded row, the way the header checkbox does. */
function selectWholePage(ids = ['a', 'b', 'c']) {
	stateBuckets.get('postbox:bulk:mbx').value = new Set(ids);
}

const hatchOf = (w: ReturnType<typeof mountRow>) =>
	w.findAll('button').find((b) => b.text() === 'Select everything in this folder');

describe('PostboxBulkSelectAllRow', () => {
	it('says nothing until the loaded page is covered', async () => {
		const w = mountRow();
		expect(w.text()).toBe('');

		selectWholePage(['a']);
		await w.vm.$nextTick();
		expect(w.text()).toBe('');

		selectWholePage();
		await w.vm.$nextTick();
		expect(w.text()).toContain('Select everything in this folder');
	});

	it('asks the server for the folder scope and adopts the answer', async () => {
		const w = mountRow({ sortOrder: 'oldest' });
		selectWholePage();
		await w.vm.$nextTick();
		await hatchOf(w)!.trigger('click');
		await new Promise((resolve) => setTimeout(resolve, 0));
		await w.vm.$nextTick();

		expect(listMessageIds).toHaveBeenCalledTimes(1);
		// The list's own arrival direction rides along, so a capped answer keeps
		// the ids the user is actually looking at.
		expect(listMessageIds.mock.calls[0]?.[1]).toMatchObject({
			mailboxId: 'mbx',
			folderRole: 'inbox',
			sortOrder: 'oldest',
		});
		expect(w.text()).toContain('3 messages selected.');
	});

	it('withholds the hatch while a chip filters the list', async () => {
		const w = mountRow({ scopeMatchesList: false });
		selectWholePage();
		await w.vm.$nextTick();

		expect(hatchOf(w)).toBeUndefined();
		// The page selection itself is untouched — only the promise it can't keep
		// is gone, and the count that tells the user what IS selected stays.
		expect(w.text()).toContain('All 3 loaded messages are selected.');
	});

	it('offers it again once the filter is cleared', async () => {
		const w = mountRow({ scopeMatchesList: false });
		selectWholePage();
		await w.vm.$nextTick();
		await w.setProps({ scopeMatchesList: true });

		expect(hatchOf(w)).toBeDefined();
	});

	it('never reaches the server for a scope the list is not showing', async () => {
		const w = mountRow({ scopeMatchesList: false });
		selectWholePage();
		await w.vm.$nextTick();
		// Belt and braces: the handler itself refuses, so no future caller can
		// re-expose the unsafe query by rendering a control that reaches it.
		const vm = w.vm as unknown as { selectAllMatching: () => Promise<void> };
		await vm.selectAllMatching();

		expect(listMessageIds).not.toHaveBeenCalled();
	});
});
