/**
 * The `vi.mock` factory for `../lib/sessionOrganization`, in a module of its
 * OWN.
 *
 * It must stay import-light: `vi.mock` factories are evaluated the first time
 * the mocked module is requested, and a factory that (transitively) imports the
 * mocked module deadlocks the worker — the import waits on the factory, the
 * factory waits on the import, and vitest reports nothing at all because it
 * never reaches collection. Living in `preflightFixtures.ts` did exactly that:
 * those fixtures import `../campaigns/preflight`, which reaches
 * `lib/sessionOrganization`. Keep this file's imports to `vitest` only.
 *
 * Call site:
 *
 * ```ts
 * vi.mock('../lib/sessionOrganization', async () => {
 *   const { sessionOrganizationMock } = await import('./sessionOrganizationMock');
 *   return await sessionOrganizationMock();
 * });
 * ```
 */

import { vi } from 'vitest';

/**
 * The tenant a suite that also mocks `getSingletonOrganizationId` resolves to.
 * Lives here, beside the factory, so a fixture seeding org-scoped rows and the
 * mock answering for the org cannot drift apart — and so a suite can name it
 * without importing anything heavier than this module.
 */
export const MOCK_SINGLETON_ORG = 'org_preflight';

export async function sessionOrganizationMock(): Promise<Record<string, unknown>> {
	const actual = await vi.importActual<Record<string, unknown>>('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
	};
}
