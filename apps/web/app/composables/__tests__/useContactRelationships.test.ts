import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

// useContactRelationships leans on four project composables that Nuxt
// auto-imports. Stub them as globals so the composable can run under vitest and
// we can exercise the contact-picker wiring (the gap this file guards against:
// the Add Relationship form used to demand a pasted internal contact id).

type Candidate = { _id: string; email: string; firstName?: string; lastName?: string };

const candidatesRef = ref<Candidate[]>([]);
const searchRef = ref('');
let lastListArgsFactory: (() => unknown) | null = null;
// Track each useBackendOperation(run) keyed by the mutation's stable function
// name (anyApi proxy refs aren't === comparable) so a test can assert exactly
// which backend mutation a handler invokes.
let runsByQuery: Map<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
	candidatesRef.value = [];
	searchRef.value = '';
	lastListArgsFactory = null;
	runsByQuery = new Map();

	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', (query: Parameters<typeof getFunctionName>[0]) => {
		const run = vi.fn();
		runsByQuery.set(getFunctionName(query), run);
		return { run };
	});
	vi.stubGlobal('useDebouncedSearch', () => ({
		searchQuery: searchRef,
		debouncedSearch: searchRef,
	}));
	vi.stubGlobal('usePaginatedQuery', (_query: unknown, argsFactory: () => unknown) => {
		lastListArgsFactory = argsFactory;
		return { results: candidatesRef, status: ref('Exhausted'), loadMore: vi.fn(), isLoading: ref(false) };
	});
});

async function load() {
	const mod = await import('../useContactRelationships');
	return mod.useContactRelationships;
}

const currentId = 'contact_self' as Id<'contacts'>;

describe('useContactRelationships — contact picker', () => {
	it('excludes the current contact from search candidates', async () => {
		const useContactRelationships = await load();
		candidatesRef.value = [
			{ _id: 'contact_self', email: 'self@example.com' },
			{ _id: 'contact_other', email: 'other@example.com', firstName: 'Jane' },
		];
		const { targetCandidates } = useContactRelationships(ref(currentId) as Ref<Id<'contacts'>>);
		expect(targetCandidates.value.map((c) => c._id)).toEqual(['contact_other']);
	});

	it('formats the label as the full name, falling back to email', async () => {
		const useContactRelationships = await load();
		const { contactLabel } = useContactRelationships(ref(currentId) as Ref<Id<'contacts'>>);
		expect(contactLabel({ _id: 'a', email: 'a@x.com', firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
		expect(contactLabel({ _id: 'b', email: 'b@x.com' })).toBe('b@x.com');
	});

	it('selecting a candidate sets toContactId + label and clears the search box', async () => {
		const useContactRelationships = await load();
		searchRef.value = 'jane';
		const { addForm, selectTargetContact, targetSearch } = useContactRelationships(
			ref(currentId) as Ref<Id<'contacts'>>,
		);
		selectTargetContact({ _id: 'contact_other', email: 'other@example.com', firstName: 'Jane' });
		expect(addForm.toContactId).toBe('contact_other');
		expect(addForm.toContactLabel).toBe('Jane');
		expect(targetSearch.value).toBe('');
	});

	it('clearing the target resets id and label', async () => {
		const useContactRelationships = await load();
		const { addForm, selectTargetContact, clearTargetContact } = useContactRelationships(
			ref(currentId) as Ref<Id<'contacts'>>,
		);
		selectTargetContact({ _id: 'contact_other', email: 'other@example.com' });
		clearTargetContact();
		expect(addForm.toContactId).toBe('');
		expect(addForm.toContactLabel).toBe('');
	});

	it('passes the debounced search term through to the list query args', async () => {
		const useContactRelationships = await load();
		useContactRelationships(ref(currentId) as Ref<Id<'contacts'>>);
		searchRef.value = 'acme';
		expect(lastListArgsFactory?.()).toEqual({ search: 'acme' });
		searchRef.value = '';
		expect(lastListArgsFactory?.()).toEqual({ search: undefined });
	});
});

describe('useContactRelationships — edit confidence', () => {
	const relId = 'rel_1' as Id<'contactRelationships'>;

	it('patches the existing relationship via updateConfidence', async () => {
		const useContactRelationships = await load();
		const { handleUpdateConfidence } = useContactRelationships(
			ref(currentId) as Ref<Id<'contacts'>>,
		);
		await handleUpdateConfidence(relId, 0.5);
		const run = runsByQuery.get(getFunctionName(api.contacts.relationships.updateConfidence));
		expect(run).toHaveBeenCalledWith({ relationshipId: relId, confidence: 0.5 });
	});

	it('clamps confidence into the [0, 1] range before patching', async () => {
		const useContactRelationships = await load();
		const { handleUpdateConfidence } = useContactRelationships(
			ref(currentId) as Ref<Id<'contacts'>>,
		);
		await handleUpdateConfidence(relId, 1.4);
		await handleUpdateConfidence(relId, -0.3);
		const run = runsByQuery.get(getFunctionName(api.contacts.relationships.updateConfidence));
		expect(run).toHaveBeenNthCalledWith(1, { relationshipId: relId, confidence: 1 });
		expect(run).toHaveBeenNthCalledWith(2, { relationshipId: relId, confidence: 0 });
	});
});
