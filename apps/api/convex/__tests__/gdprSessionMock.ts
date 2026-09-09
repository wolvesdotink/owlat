/**
 * The `vi.mock` factory for `../lib/sessionOrganization` used by the GDPR
 * account suites (gdprAccount*.integration.test.ts), in an import-light module
 * of its own — see sessionOrganizationMock.ts for why a factory must not pull
 * in the fixtures it serves. Keep this file's imports to `vitest` only.
 *
 * Call site:
 *
 * ```ts
 * vi.mock('../lib/sessionOrganization', async () => {
 *   const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
 *   return await gdprSessionOrganizationMock();
 * });
 * ```
 */

import { vi } from 'vitest';

// The session is parameterized per test: requireSelf passes only for the
// fixed session user, and the caller's role (owner/admin/editor) decides
// whether exportUserData surfaces the admin-only api-key/webhook metadata.
export const sessionMock = {
	userId: 'auth-user-1',
	role: 'owner' as 'owner' | 'admin' | 'editor',
};

export function resetSessionMock(): void {
	sessionMock.userId = 'auth-user-1';
	sessionMock.role = 'owner';
}

// requireSelf calls getUserIdFromSession through a *local* reference, so
// mocking the export alone doesn't intercept it — mock requireSelf directly.
// requireOrgMember / getMutationContext are the authedQuery/authedMutation
// floors and must succeed for the handler to run at all.
export async function gdprSessionOrganizationMock(): Promise<Record<string, unknown>> {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	return {
		...actual,
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
		requireSelf: vi.fn().mockImplementation(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMock.userId) {
				throw new Error('unauthenticated');
			}
			return sessionMock.userId;
		}),
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
	};
}
