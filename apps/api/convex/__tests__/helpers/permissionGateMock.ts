type SessionModule = typeof import('../../lib/sessionOrganization');
type Role = Parameters<SessionModule['hasPermission']>[0];
type Permission = Parameters<SessionModule['hasPermission']>[1];

/**
 * Build a `requireOrgPermission` mock implementation that runs the REAL
 * permission gate against a (mutable) role, so a test pins the actual
 * `PERMISSION_MAP` behavior instead of stubbing the gate open.
 *
 * `requirePermission` is an assertion function (`asserts hasPermission`), so its
 * call target must be an explicitly-annotated binding — hence `actual` is typed
 * as `SessionModule` here rather than the inferred `vi.importActual<...>()`
 * result, which TS2775 rejects at the call site.
 *
 * Usage inside a `vi.mock` factory (hoisted, so import the helper with
 * `await import(...)`):
 *
 *   const { realPermissionGate } = await import('.../helpers/permissionGateMock');
 *   const gate = realPermissionGate(actual, () => roleMock.role);
 *   // ...
 *   requireOrgPermission: vi.fn().mockImplementation(async (ctx, permission, message) => {
 *     gate(permission, message);
 *     return session();
 *   }),
 */
export function realPermissionGate(actual: SessionModule, getRole: () => Role) {
	return (permission: string, message?: string): void => {
		actual.requirePermission(actual.hasPermission(getRole(), permission as Permission), message);
	};
}
