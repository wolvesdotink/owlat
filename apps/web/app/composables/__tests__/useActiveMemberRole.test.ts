/**
 * `useActiveMemberRole`: the member's role from one `getActiveMember` lookup,
 * keyed on the session's user + active organization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';

// Fresh refs per case, not reset values: a previous case's detached watcher is
// still alive and would otherwise react to this case's session changes.
let userId = ref<string | null>('u-1');
let organizationId = ref<string | null>('org-1');
const getActiveMember = vi.fn();

type Answer = { data: { role: string } | null; error: { message: string } | null };
const answer = (role: string | null): Answer =>
	role ? { data: { role }, error: null } : { data: null, error: { message: 'FORBIDDEN' } };

async function load() {
	vi.resetModules();
	vi.doMock('~/lib/auth-client', () => ({ getActiveMember }));
	const state = new Map<string, unknown>();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!state.has(key)) state.set(key, ref(init()));
		return state.get(key);
	});
	const user = userId;
	const organization = organizationId;
	vi.stubGlobal('useAuth', () => ({
		user: computed(() => (user.value ? { id: user.value } : null)),
		activeOrganizationId: computed(() => organization.value),
	}));
	return import('../useActiveMemberRole');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	userId = ref<string | null>('u-1');
	organizationId = ref<string | null>('org-1');
	getActiveMember.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('~/lib/auth-client');
});

describe('useActiveMemberRole', () => {
	it("maps better-auth's member role to editor", async () => {
		getActiveMember.mockResolvedValue(answer('member'));
		const { useActiveMemberRole } = await load();
		const { role, isResolved } = useActiveMemberRole();
		expect(isResolved.value).toBe(false);

		await flush();
		expect(isResolved.value).toBe(true);
		expect(role.value).toBe('editor');
	});

	it('looks the role up once however many callers ask', async () => {
		getActiveMember.mockResolvedValue(answer('owner'));
		const { useActiveMemberRole } = await load();
		useActiveMemberRole();
		useActiveMemberRole();
		useActiveMemberRole();
		await flush();
		expect(getActiveMember).toHaveBeenCalledOnce();
	});

	it('settles without a role when the member is not in the organization', async () => {
		getActiveMember.mockResolvedValue(answer(null));
		const { useActiveMemberRole } = await load();
		const { role, isResolved } = useActiveMemberRole();
		await flush();
		expect(isResolved.value).toBe(true);
		expect(role.value).toBeNull();
	});

	it('settles without a role when the first lookup fails', async () => {
		getActiveMember.mockRejectedValue(new Error('offline'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { useActiveMemberRole } = await load();
		const { role, isResolved } = useActiveMemberRole();
		await flush();
		expect(isResolved.value).toBe(true);
		expect(role.value).toBeNull();
		consoleError.mockRestore();
	});

	it('keeps the known role when a refresh fails', async () => {
		getActiveMember.mockResolvedValueOnce(answer('admin'));
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { useActiveMemberRole } = await load();
		const { role, refresh } = useActiveMemberRole();
		await flush();
		expect(role.value).toBe('admin');

		getActiveMember.mockRejectedValueOnce(new Error('offline'));
		await refresh();
		expect(role.value).toBe('admin');
		consoleError.mockRestore();
	});

	it('is unresolved again after an organization switch, and ignores the stale answer', async () => {
		let releaseFirst!: (value: Answer) => void;
		getActiveMember.mockImplementationOnce(
			() => new Promise<Answer>((resolve) => (releaseFirst = resolve))
		);
		getActiveMember.mockResolvedValueOnce(answer('member'));
		const { useActiveMemberRole } = await load();
		const { role, isResolved } = useActiveMemberRole();

		organizationId.value = 'org-2';
		await nextTick();
		await flush();
		expect(role.value).toBe('editor');
		expect(isResolved.value).toBe(true);

		// The first organization's answer lands late; it must not win.
		releaseFirst(answer('owner'));
		await flush();
		expect(role.value).toBe('editor');
	});

	it('is resolved with no role once signed out', async () => {
		getActiveMember.mockResolvedValue(answer('owner'));
		const { useActiveMemberRole } = await load();
		const { role, isResolved } = useActiveMemberRole();
		await flush();
		expect(role.value).toBe('owner');

		userId.value = null;
		organizationId.value = null;
		await nextTick();
		expect(isResolved.value).toBe(true);
		expect(role.value).toBeNull();
	});
});
