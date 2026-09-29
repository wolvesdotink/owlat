import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick, ref } from 'vue';
import type { FunctionReference } from 'convex/server';
import { useConvexQuery } from '../useConvexQuery';
import { usePaginatedQuery } from '../usePaginatedQuery';
import { useOrganizationPaginatedQuery, useOrganizationQuery } from '../useOrganizationQuery';

const fakeQuery = 'api.test.list' as unknown as FunctionReference<'query'>;

const organizationId = ref<string | null>(null);
const isPending = ref(true);
const isAuthenticated = ref(false);
let client: {
	onUpdate: ReturnType<typeof vi.fn>;
	onPaginatedUpdate_experimental: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
	organizationId.value = null;
	isPending.value = true;
	isAuthenticated.value = false;
	client = {
		onUpdate: vi.fn(() => vi.fn()),
		onPaginatedUpdate_experimental: vi.fn(() => vi.fn()),
	};
	vi.stubGlobal('useConvex', () => client);
	vi.stubGlobal('useAuth', () => ({ isPending, isAuthenticated }));
	vi.stubGlobal('useOrganizationContext', () => ({ organizationId }));
	vi.stubGlobal('useConvexQuery', useConvexQuery);
	vi.stubGlobal('usePaginatedQuery', usePaginatedQuery);
});

async function signInToOrganization() {
	isPending.value = false;
	isAuthenticated.value = true;
	await nextTick();
	organizationId.value = 'org_1';
	await nextTick();
}

describe('useOrganizationPaginatedQuery', () => {
	it('skips until the session is signed in and has an active organization', async () => {
		const { isLoading } = useOrganizationPaginatedQuery(fakeQuery, undefined, {
			initialNumItems: 100,
		});
		expect(isLoading.value).toBe(true);

		isPending.value = false;
		isAuthenticated.value = true;
		await nextTick();
		// Signed in, but no organization yet: still no subscription.
		expect(client.onPaginatedUpdate_experimental).not.toHaveBeenCalled();

		organizationId.value = 'org_1';
		await nextTick();
		expect(client.onPaginatedUpdate_experimental).toHaveBeenCalledOnce();
		expect(client.onPaginatedUpdate_experimental).toHaveBeenCalledWith(
			fakeQuery,
			{},
			{ initialNumItems: 100 },
			expect.any(Function),
			expect.any(Function)
		);
	});

	it('passes extra args, and skips while their factory returns undefined', async () => {
		const status = ref<string | undefined>(undefined);
		useOrganizationPaginatedQuery(
			fakeQuery,
			() => (status.value ? { status: status.value } : undefined),
			{ initialNumItems: 20 }
		);
		await signInToOrganization();
		expect(client.onPaginatedUpdate_experimental).not.toHaveBeenCalled();

		status.value = 'draft';
		await nextTick();
		expect(client.onPaginatedUpdate_experimental).toHaveBeenCalledWith(
			fakeQuery,
			{ status: 'draft' },
			{ initialNumItems: 20 },
			expect.any(Function),
			expect.any(Function)
		);
	});

	it('takes a plain extra-args object', async () => {
		useOrganizationPaginatedQuery(fakeQuery, { type: 'marketing' }, { initialNumItems: 100 });
		await signInToOrganization();
		expect(client.onPaginatedUpdate_experimental).toHaveBeenCalledWith(
			fakeQuery,
			{ type: 'marketing' },
			{ initialNumItems: 100 },
			expect.any(Function),
			expect.any(Function)
		);
	});
});

describe('useOrganizationQuery', () => {
	it('uses the same gate', async () => {
		useOrganizationQuery(fakeQuery, { reason: 'bounce' });
		isPending.value = false;
		isAuthenticated.value = true;
		await nextTick();
		expect(client.onUpdate).not.toHaveBeenCalled();

		organizationId.value = 'org_1';
		await nextTick();
		expect(client.onUpdate).toHaveBeenCalledWith(
			fakeQuery,
			{ reason: 'bounce' },
			expect.any(Function),
			expect.any(Function)
		);
	});
});
