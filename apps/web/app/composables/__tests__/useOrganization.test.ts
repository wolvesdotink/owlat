import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { computed, ref, watch } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { planOwnershipTransfer } from '../useOrganization';
import { organizationTranslator } from '../useOrganizationSession';

// `planOwnershipTransfer` is module scope, so it throws the message KEY and
// `transferOwnership` resolves it; resolving it here keeps the assertions on
// the English sentence a member actually reads.
const { t } = createTestI18n().global;
const refusalOf = (plan: () => unknown): string => {
	try {
		plan();
	} catch (error) {
		return t((error as Error).message);
	}
	throw new Error('expected the transfer to be refused');
};

const owner = { id: 'm-owner', userId: 'u-owner', role: 'owner' as const };
const admin = { id: 'm-admin', userId: 'u-admin', role: 'admin' as const };
const editor = { id: 'm-editor', userId: 'u-editor', role: 'editor' as const };

describe('planOwnershipTransfer', () => {
	it('promotes the new owner FIRST, then demotes the current owner', () => {
		const steps = planOwnershipTransfer([owner, admin, editor], 'u-owner', 'm-admin');

		// Order is load-bearing: promoting first guarantees the org is never left
		// without an owner, so BetterAuth permits the subsequent demotion.
		expect(steps).toEqual([
			{ memberId: 'm-admin', role: 'owner' },
			{ memberId: 'm-owner', role: 'admin' },
		]);
	});

	it('can hand off to an editor as well as an admin', () => {
		const steps = planOwnershipTransfer([owner, admin, editor], 'u-owner', 'm-editor');
		expect(steps[0]).toEqual({ memberId: 'm-editor', role: 'owner' });
		expect(steps[1]).toEqual({ memberId: 'm-owner', role: 'admin' });
	});

	it('rejects the transfer when the caller is not the current owner', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], 'u-admin', 'm-editor'))).toMatch(
			/only the current owner/i
		);
	});

	it('rejects the transfer when the caller is unknown / unauthenticated', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], null, 'm-admin'))).toMatch(
			/only the current owner/i
		);
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], undefined, 'm-admin'))).toMatch(
			/only the current owner/i
		);
	});

	it('rejects a no-op transfer to the current owner', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], 'u-owner', 'm-owner'))).toMatch(
			/already the owner/i
		);
	});
});

describe('organizationTranslator (middleware-context guard)', () => {
	// Regression for the admin-route 500: `useOrganization` is called from the
	// `admin`-gated route guard, which runs OUTSIDE a Vue component instance,
	// where `useI18n()` throws. This suite deliberately does NOT install/stub the
	// i18n plugin — so if the `getCurrentInstance()` guard regressed, invoking the
	// translator would reference the undefined `useI18n` auto-import and throw,
	// re-500-ing every admin page. The guard must degrade a key to itself instead.
	it('does not call useI18n outside a component instance (no throw)', () => {
		// The test body runs with no current component instance, exactly like a
		// route middleware. getCurrentInstance() is the real Vue one here.
		expect(getCurrentInstance()).toBeNull();
		let t!: (key: string) => string;
		expect(() => {
			t = organizationTranslator();
		}).not.toThrow();
		// Falls back to the key itself rather than a resolved sentence.
		expect(t('shared.useOrganization.errors.noActiveOrganization')).toBe(
			'shared.useOrganization.errors.noActiveOrganization'
		);
	});
});

/**
 * `useOrganization` reached for `useAuth()` from inside `fetchMembers`,
 * `transferOwnership` and `setActive` — all of them after an `await`, where
 * there is no effect scope for the session store's listener to be released
 * from, and no component instance for `useAuth`'s translator. Each fetch left a
 * subscriber behind. One `useAuth()` per composable call, closed over.
 */
describe('useOrganization session wiring', () => {
	// A fresh ref per case: an earlier case's detached members watcher stays
	// subscribed to the ref it was built on, and must not see this case's switch.
	let activeOrganization = ref<{ id: string } | null>({ id: 'org-1' });
	const listMembers = vi.fn(async () => ({
		data: { members: [{ id: 'm-owner', userId: 'u-owner', role: 'owner' }] },
	}));
	const listInvitations = vi.fn(async () => ({ data: [] as unknown[] }));

	beforeEach(() => {
		vi.resetModules();
		activeOrganization = ref<{ id: string } | null>({ id: 'org-1' });
		listMembers.mockClear();
		listInvitations.mockClear();
		vi.doMock('~/lib/auth-client', () => ({
			useActiveOrganization: () =>
				computed(() => ({ data: activeOrganization.value, error: null, isPending: false })),
			useListOrganizations: () => computed(() => ({ data: [] })),
			listMembers,
			listInvitations,
			inviteMember: vi.fn(),
			removeMember: vi.fn(),
			updateMemberRole: vi.fn(),
			cancelInvitation: vi.fn(),
			setActiveOrganization: async ({ organizationId }: { organizationId: string }) => {
				activeOrganization.value = { id: organizationId };
				return { data: { id: organizationId }, error: null };
			},
			updateOrganization: vi.fn(),
			getFullOrganization: vi.fn(),
		}));

		const state = new Map<string, unknown>();
		vi.stubGlobal('useState', (key: string, init: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init()));
			return state.get(key);
		});
		vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
		// `afterEach` unstubs the setup file's auto-import globals too, so every
		// case puts back the ones these composables use. No component instance:
		// called the way the guards call them.
		vi.stubGlobal('ref', ref);
		vi.stubGlobal('computed', computed);
		vi.stubGlobal('watch', watch);
		vi.stubGlobal('getCurrentInstance', () => null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.doUnmock('~/lib/auth-client');
	});

	it('builds useAuth once per call, however many fetches run', async () => {
		const useAuthSpy = vi.fn(() => ({
			user: ref({ id: 'u-owner' }),
			refetch: vi.fn(async () => null),
		}));
		vi.stubGlobal('useAuth', useAuthSpy);

		const { useOrganization } = await import('../useOrganization');
		const organization = useOrganization();
		expect(useAuthSpy).toHaveBeenCalledOnce();

		await organization.fetchMembers({ force: true });
		await organization.fetchMembers({ force: true });
		expect(listMembers.mock.calls.length).toBeGreaterThanOrEqual(2);

		expect(useAuthSpy).toHaveBeenCalledOnce();
		expect(organization.currentMemberRole.value).toBe('owner');
	});

	it('refreshes a roster a page is holding when the switch comes through the session', async () => {
		vi.stubGlobal('useAuth', () => ({
			user: ref({ id: 'u-owner' }),
			refetch: vi.fn(async () => null),
		}));
		const { useOrganization } = await import('../useOrganization');
		const { useOrganizationSession } = await import('../useOrganizationSession');
		const organization = useOrganization();
		await organization.fetchMembers({ force: true });
		listMembers.mockClear();

		// Re-selecting the active organization changes nothing the members
		// watcher sees, and the lists are inside their cache TTL: only the
		// forced refresh that `setActive` awaits loads them.
		await useOrganizationSession().setActive('org-1');

		expect(listMembers).toHaveBeenCalledWith({ query: { organizationId: 'org-1' } });
	});

	it("keeps the planner's refusal as the cause of the translated transfer error", async () => {
		vi.stubGlobal('useAuth', () => ({
			user: ref({ id: 'u-admin' }),
			refetch: vi.fn(async () => null),
		}));
		const { useOrganization } = await import('../useOrganization');
		const organization = useOrganization();
		await organization.fetchMembers({ force: true });

		const failure = await organization.transferOwnership('m-owner').then(
			() => null,
			(err: unknown) => err as Error
		);
		expect(failure?.message).toBe('shared.useOrganization.errors.notCurrentOwner');
		expect(failure?.cause).toBeInstanceOf(Error);
		expect(failure?.cause).toMatchObject({
			message: 'shared.useOrganization.errors.notCurrentOwner',
		});
	});

	it('loads no roster on a switch when no page asked for one', async () => {
		vi.stubGlobal('useAuth', () => ({
			user: ref({ id: 'u-owner' }),
			refetch: vi.fn(async () => null),
		}));
		const { useOrganizationSession } = await import('../useOrganizationSession');
		const { useOrganization } = await import('../useOrganization');
		useOrganization();

		await useOrganizationSession().setActive('org-2');

		expect(listMembers).not.toHaveBeenCalled();
	});
});
