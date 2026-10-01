/**
 * The Postbox page renders with `usePostboxMailbox().mailboxId` (plan 2.5):
 * before `identity.list` answers it is seeded from the persisted choice once
 * the shell's `accessible` rows vouch for it, so the list and the open message
 * start loading without waiting for the mailbox list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, reactive, ref, type Ref } from 'vue';
import { getFunctionName } from 'convex/server';

const list = ref<Array<{ _id: string }> | undefined>(undefined);
const listLoading = ref(true);
const accessible = ref<Array<{ mailboxId: string }> | undefined>(undefined);
const persisted = ref<string | null>(null);
const route = reactive<{ query: Record<string, unknown> }>({ query: {} });

function queryStub(name: string): {
	data: Ref<unknown>;
	isLoading: Ref<boolean>;
	error: Ref<null>;
} {
	if (name === 'mail/mailbox/identity:list') {
		return { data: list, isLoading: listLoading, error: ref(null) };
	}
	if (name === 'mail/mailbox/queries:accessible') {
		return { data: accessible, isLoading: ref(accessible.value === undefined), error: ref(null) };
	}
	throw new Error(`unexpected query ${name}`);
}

beforeEach(() => {
	list.value = undefined;
	listLoading.value = true;
	accessible.value = undefined;
	persisted.value = null;
	route.query = {};
	vi.stubGlobal('useConvexQuery', (query: unknown) => queryStub(getFunctionName(query as never)));
	vi.stubGlobal('useRoute', () => route);
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('usePostboxActiveMailbox', () => ({
		activeMailboxId: persisted,
		setActiveMailboxId: (id: string) => {
			persisted.value = id;
		},
	}));
});

async function setup() {
	const { usePostboxMailbox } = await import('../usePostboxMailbox');
	const scope = effectScope();
	const result = scope.run(() => usePostboxMailbox());
	if (!result) throw new Error('no result');
	return result;
}

describe('usePostboxMailbox mailboxId', () => {
	it('stays null while neither the mailbox list nor the accessible rows are known', async () => {
		persisted.value = 'mb-2';
		const { mailboxId } = await setup();
		expect(mailboxId.value).toBe(null);
	});

	it('seeds the persisted mailbox from the accessible rows before the list loads', async () => {
		persisted.value = 'mb-2';
		accessible.value = [{ mailboxId: 'mb-1' }, { mailboxId: 'mb-2' }];
		const { mailboxId, currentMailbox } = await setup();
		expect(currentMailbox.value).toBe(null);
		expect(mailboxId.value).toBe('mb-2');

		// The list agrees: the id does not change.
		list.value = [{ _id: 'mb-1' }, { _id: 'mb-2' }];
		listLoading.value = false;
		expect(mailboxId.value).toBe('mb-2');
	});

	it('falls back to the list for a persisted id the accessible rows do not vouch for', async () => {
		persisted.value = 'gone';
		accessible.value = [{ mailboxId: 'mb-1' }];
		const { mailboxId } = await setup();
		expect(mailboxId.value).toBe(null);

		list.value = [{ _id: 'mb-1' }];
		listLoading.value = false;
		expect(mailboxId.value).toBe('mb-1');
	});

	it('is null once the list has loaded empty, whatever the seed said', async () => {
		accessible.value = [{ mailboxId: 'mb-1' }];
		const { mailboxId } = await setup();
		expect(mailboxId.value).toBe('mb-1');
		list.value = [];
		listLoading.value = false;
		expect(mailboxId.value).toBe(null);
	});
});
