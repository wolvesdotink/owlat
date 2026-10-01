/**
 * A stand-in for `emails.list` and `emails.get` behind the two query
 * composables the template picker reads through.
 *
 * It holds more templates than one page and answers like the server: a
 * `search` argument filters the WHOLE set (name and subject, as
 * `searchableText` does), the rest is paged `initialNumItems` at a time through
 * `loadMore`. Answers land on a microtask, or wait for `flush()` while
 * `hold` is set, so a suite can look at the in-flight state.
 */
import { vi } from 'vitest';
import { computed, ref, shallowRef, watch } from 'vue';
import type { Doc, Id } from '@owlat/api/dataModel';

export type Template = Doc<'emailTemplates'>;

export function makeTemplates(count: number): Template[] {
	return Array.from({ length: count }, (_, i) => {
		const n = i + 1;
		return {
			_id: `tpl_${n}` as Id<'emailTemplates'>,
			_creationTime: 0,
			name: `Template ${n}`,
			subject: `Subject line ${n}`,
			type: 'marketing',
			status: n % 2 === 0 ? 'published' : 'draft',
			updatedAt: count - i,
		} as unknown as Template;
	});
}

type ListArgs = { type?: string; search?: string };

export function createTemplateServer(all: Template[]) {
	const state = {
		/** Every args object the list subscription was opened with. */
		listCalls: [] as ListArgs[],
		loadMoreCalls: 0,
		/** Hold answers until `flush()`. */
		hold: false,
		/** The next answer is a failure. */
		fail: false,
		refetch: vi.fn(),
	};
	const queued: Array<() => void> = [];

	function answer(fn: () => void) {
		if (state.hold) queued.push(fn);
		else void Promise.resolve().then(fn);
	}

	function matching(args: ListArgs): Template[] {
		const search = args.search?.toLowerCase();
		if (!search) return all;
		return all.filter((t) => `${t.name} ${t.subject}`.toLowerCase().includes(search));
	}

	function useOrganizationPaginatedQuery(
		_query: unknown,
		argsFactory: () => ListArgs | undefined,
		options: { initialNumItems: number }
	) {
		const results = shallowRef<Template[]>([]);
		const status = ref('LoadingFirstPage');
		const isLoading = ref(true);
		const error = ref<Error | null>(null);
		let pages = 1;
		let current: ListArgs = {};
		let generation = 0;

		const deliver = (gen: number) => () => {
			if (gen !== generation) return;
			if (state.fail) {
				state.fail = false;
				error.value = new Error('[CONVEX Q(emailTemplates/emails:list)] Server Error');
				isLoading.value = false;
				return;
			}
			const rows = matching(current);
			const shown = pages * options.initialNumItems;
			results.value = rows.slice(0, shown);
			status.value = rows.length > shown ? 'CanLoadMore' : 'Exhausted';
			isLoading.value = false;
		};

		watch(
			() => JSON.stringify(argsFactory() ?? null),
			(key) => {
				current = JSON.parse(key) ?? {};
				state.listCalls.push(current);
				generation += 1;
				pages = 1;
				results.value = [];
				status.value = 'LoadingFirstPage';
				isLoading.value = true;
				error.value = null;
				answer(deliver(generation));
			},
			{ immediate: true }
		);

		return {
			results,
			status,
			isLoading,
			isRefetching: ref(false),
			error,
			refetch: state.refetch,
			loadMore: () => {
				if (status.value !== 'CanLoadMore') return;
				state.loadMoreCalls += 1;
				pages += 1;
				status.value = 'LoadingMore';
				answer(deliver(generation));
			},
		};
	}

	function useOrganizationQuery(
		_query: unknown,
		argsFactory: () => { templateId: string } | undefined
	) {
		return {
			data: computed(() => {
				const args = argsFactory();
				if (!args) return undefined;
				return all.find((t) => t._id === args.templateId) ?? null;
			}),
			isLoading: ref(false),
			isRefetching: ref(false),
			error: ref(null),
			refetch: vi.fn(),
		};
	}

	return {
		state,
		useOrganizationPaginatedQuery,
		useOrganizationQuery,
		flush() {
			for (const fn of queued.splice(0)) fn();
		},
	};
}
