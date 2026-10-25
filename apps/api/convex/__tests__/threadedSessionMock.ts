/**
 * A `vi.mock` factory for `../lib/sessionOrganization` that lets a suite prove
 * a handler used the session its builder floor resolved (the handler's third
 * argument) instead of resolving it again.
 *
 * Every resolver answers from one mutable session, so a handler that re-resolves
 * still gets the same answer and only the call counts tell the two apart. The
 * role-bearing resolvers apply the real permission check to that session, so an
 * editor is refused with the message the production gate would use.
 *
 * Keep this file's runtime imports to `vitest` only: a `vi.mock` factory that
 * transitively imports the mocked module deadlocks the worker (see
 * `./sessionOrganizationMock.ts`).
 *
 * Call site:
 *
 * ```ts
 * vi.mock('../lib/sessionOrganization', async () => {
 *   const { threadedSessionMock } = await import('./threadedSessionMock');
 *   return await threadedSessionMock();
 * });
 * import * as sessionOrganization from '../lib/sessionOrganization';
 * ```
 */

import { expect, vi } from 'vitest';
import type * as SessionOrganization from '../lib/sessionOrganization';

type Role = 'owner' | 'admin' | 'editor';
type Permission = Parameters<typeof SessionOrganization.hasPermission>[1];

/** The caller every mocked resolver answers with. Mutate through `setSession`. */
export const mockSession = {
	userId: 'admin-user',
	role: 'owner' as Role,
	activeOrganizationId: 'org-1',
};

export function setSession(userId: string, role: Role, activeOrganizationId = 'org-1'): void {
	mockSession.userId = userId;
	mockSession.role = role;
	mockSession.activeOrganizationId = activeOrganizationId;
}

/** The floor each org-scoped builder resolves (`lib/authedFunctions.ts`). */
export type Floor = 'requireOrgMember' | 'getMutationContext' | 'requireAdminContext';

/** Every helper that resolves a session, floor or not. */
const RESOLVERS = [
	'requireOrgMember',
	'getMutationContext',
	'requireAdminContext',
	'requireOwnerContext',
	'requireOrgPermission',
	'getBetterAuthSessionWithRole',
	'getBetterAuthSession',
	'getUserIdFromSession',
] as const;

export async function threadedSessionMock(): Promise<Record<string, unknown>> {
	const actual = await vi.importActual<typeof SessionOrganization>('../lib/sessionOrganization');
	const current = () => ({ ...mockSession });
	const gate = (permission: Permission, message?: string) => {
		actual.requirePermission(actual.hasPermission(mockSession.role, permission), message);
		return current();
	};
	return {
		...actual,
		requireOrgMember: vi.fn(async () => current()),
		getMutationContext: vi.fn(async () => current()),
		requireAdminContext: vi.fn(async (_ctx: unknown, message?: string) =>
			gate('organization:manage', message ?? 'Only owners and admins can perform this action')
		),
		requireOwnerContext: vi.fn(async (_ctx: unknown, message?: string) =>
			gate('organization:delete', message ?? 'Only owners can perform this action')
		),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: Permission, message?: string) =>
			gate(permission, message)
		),
		getBetterAuthSessionWithRole: vi.fn(async () => current()),
		getBetterAuthSession: vi.fn(async () => current()),
		getUserIdFromSession: vi.fn(async () => mockSession.userId),
		isActiveOrgMember: vi.fn(async () => true),
	};
}

/** Reset the call counts of every resolver on the mocked module. */
export function clearResolverCalls(mod: typeof SessionOrganization): void {
	for (const name of RESOLVERS) vi.mocked(mod[name]).mockClear();
}

/**
 * Assert that the only session resolution since the last `clearResolverCalls`
 * was `calls` invocations of `floor`: no handler re-derived the session.
 */
export function expectOnlyFloor(mod: typeof SessionOrganization, floor: Floor, calls = 1): void {
	const counts = Object.fromEntries(
		RESOLVERS.map((name) => [name, vi.mocked(mod[name]).mock.calls.length])
	);
	const expected = Object.fromEntries(RESOLVERS.map((name) => [name, name === floor ? calls : 0]));
	expect(counts).toEqual(expected);
}
