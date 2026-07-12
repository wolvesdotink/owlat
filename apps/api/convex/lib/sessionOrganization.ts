import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { components } from '../_generated/api';
import { throwUnauthenticated, throwForbidden } from '../_utils/errors';

/** Shape returned by the BetterAuth adapter for session lookups. */
interface BetterAuthSession {
	activeOrganizationId?: string | null;
}

/** Shape returned by the BetterAuth adapter for member lookups. */
interface BetterAuthMember {
	role: string;
}

/**
 * Organization role type - matches BetterAuth custom roles.
 * Uses 'editor' instead of BetterAuth's default 'member'.
 */
export type OrganizationRole = 'owner' | 'admin' | 'editor';

/**
 * Full mutation context including user ID and role information.
 */
export interface MutationSessionContext {
	/** BetterAuth user ID */
	userId: string;
	/** User's role in the organization */
	role: OrganizationRole;
}

/**
 * Get the BetterAuth session for the current request context.
 * Returns null if no session is found or session is expired.
 *
 * Prefer claims from the Convex JWT first. We still fall back to BetterAuth's
 * session table while older tokens are rotating out or when claims are missing.
 */
export async function getBetterAuthSession(ctx: QueryCtx | MutationCtx): Promise<{
	userId: string;
	activeOrganizationId: string | null;
} | null> {
	try {
		const identity = await ctx.auth.getUserIdentity();
		if (!identity) {
			return null;
		}

		const userId = typeof identity.subject === 'string' ? identity.subject : null;
		if (!userId) {
			return null;
		}

		if ('activeOrganizationId' in identity) {
			return {
				userId,
				activeOrganizationId:
					typeof identity['activeOrganizationId'] === 'string'
						? identity['activeOrganizationId']
						: null,
			};
		}

		if (!identity['sessionId']) {
			return {
				userId,
				activeOrganizationId: null,
			};
		}

		const session = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
			model: 'session',
			where: [
				{
					field: '_id',
					value: identity['sessionId'] as string,
				},
				{
					field: 'expiresAt',
					operator: 'gt',
					value: Date.now(),
				},
			],
		})) as BetterAuthSession | null;

		return {
			userId,
			activeOrganizationId: session?.activeOrganizationId ?? null,
		};
	} catch {
		// Session access failed - user is not authenticated
		return null;
	}
}

/**
 * Per-isolate cache of the validated singleton-org id. Owlat is
 * single-org-per-deployment and the org cannot be created post-bootstrap
 * (BetterAuth `auth/organization/create` is disabled in `auth.ts`), so once
 * we've confirmed the invariant for a given org id within an isolate the
 * subsequent calls are pure equality checks. The cache is process-local —
 * a new isolate or a redeploy re-runs the full check.
 */
let cachedSingletonOrgId: string | null = null;

/** Test-only: drop the cache so unit tests can re-exercise the invariant. */
export function _resetSingletonOrgCacheForTests(): void {
	cachedSingletonOrgId = null;
}

/**
 * Owlat is single-organization-per-deployment. The one org is bootstrapped by
 * `/seed/admin` (apps/api/convex/seedAdmin.ts); BetterAuth's public
 * `auth/organization/create` endpoint is disabled in `auth.ts`. This helper is
 * the runtime defense-in-depth: it asserts that exactly one organization exists
 * and that the session's active org matches it. Throws otherwise.
 *
 * Called from `getBetterAuthSessionWithRole` so every authenticated query and
 * mutation flowing through `getMutationContext` (or directly inspecting the
 * session) trips this invariant. After the first successful check per isolate
 * we cache the id; subsequent calls are a pointer compare.
 *
 * Exported only for unit testing — production callers should go through
 * `getBetterAuthSessionWithRole` / `getMutationContext`.
 */
export async function assertSingletonOrgInvariant(
	ctx: QueryCtx | MutationCtx,
	activeOrganizationId: string
): Promise<void> {
	const singletonId = await getSingletonOrganizationId(ctx);
	if (singletonId !== activeOrganizationId) {
		throwForbidden('Active organization does not match the deployment singleton');
	}
}

/**
 * Resolve the id of the single deployment organization WITHOUT requiring the
 * caller to be a member of it.
 *
 * Owlat is single-org-per-deployment (see `assertSingletonOrgInvariant`). Most
 * callers reach the org via their session's active org, but the access-request
 * flow (auth/accessRequest.ts) is invoked by a signed-in user who belongs to no
 * organization yet — they have no active org to key off, so they need the one
 * org's id directly to address their request to its admins.
 *
 * Asserts exactly one organization exists (throwing on zero or many), and
 * caches the validated id per isolate — the same cache `assertSingletonOrgInvariant`
 * relies on, so the two helpers can never disagree.
 */
export async function getSingletonOrganizationId(ctx: QueryCtx | MutationCtx): Promise<string> {
	if (cachedSingletonOrgId !== null) {
		return cachedSingletonOrgId;
	}

	const result = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
		model: 'organization',
		where: [],
		paginationOpts: { cursor: null, numItems: 2 },
	})) as { page?: Array<{ id?: string; _id?: string }> } | null;

	const orgs = result?.page ?? [];
	if (orgs.length === 0) {
		throwForbidden('No organization configured on this Owlat instance');
	}
	if (orgs.length > 1) {
		throwForbidden(
			'Multi-organization mode is not supported. Only one organization per Owlat instance is allowed.'
		);
	}
	// The adapter returns RAW component docs: current versions expose the org id
	// only as `_id` (the component generates it and rejects a client-supplied
	// `id`), while rows written by older component versions carry an explicit
	// `id` field. Read both — `id` alone made this throw "No organization
	// configured" on healthy new deployments (same pattern as sendQueries.ts).
	const singletonId = orgs[0]?.id ?? orgs[0]?._id;
	if (!singletonId) {
		throwForbidden('No organization configured on this Owlat instance');
	}
	cachedSingletonOrgId = singletonId;
	return singletonId;
}

/**
 * Get the BetterAuth session with the user's role in their active organization.
 * Combines session + member lookup into a single helper to avoid repeated queries.
 * Returns null if not authenticated.
 *
 * Also enforces the single-org-per-deployment invariant when the session has an
 * active org — see `assertSingletonOrgInvariant`.
 */
export async function getBetterAuthSessionWithRole(ctx: QueryCtx | MutationCtx): Promise<{
	userId: string;
	activeOrganizationId: string | null;
	role: OrganizationRole | null;
} | null> {
	const session = await getBetterAuthSession(ctx);
	if (!session) return null;

	if (!session.activeOrganizationId) {
		return { ...session, role: null };
	}

	await assertSingletonOrgInvariant(ctx, session.activeOrganizationId);

	// Fetch role from member table in the same call
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: session.activeOrganizationId },
			{ field: 'userId', value: session.userId },
		],
	})) as BetterAuthMember | null;

	return {
		...session,
		role: member ? (member.role as OrganizationRole) : null,
	};
}

/**
 * Require an authenticated user identity, throwing if absent.
 *
 * Lightweight wrapper around `ctx.auth.getUserIdentity()` that collapses the
 * repeated `const identity = await ctx.auth.getUserIdentity(); if (!identity)
 * throw new Error('Authentication required');` boilerplate into one call.
 *
 * Use this for mutations and actions that must reject anonymous callers.
 * Queries that gracefully return `[]` or `null` for anonymous users should
 * stay with the explicit `if (!identity) return ...` pattern — they're
 * intentionally soft-failing for the unauthenticated UI path.
 *
 * For full session+org+role context, prefer `getMutationContext(ctx)` which
 * also enforces the singleton-org invariant.
 *
 * @param ctx - Convex query, mutation, or action context
 * @returns The Convex UserIdentity (subject, email, etc.)
 * @throws Error if not authenticated
 */
export async function requireAuthenticatedIdentity(ctx: {
	auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<NonNullable<Awaited<ReturnType<QueryCtx['auth']['getUserIdentity']>>>> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throwUnauthenticated();
	}
	return identity as NonNullable<Awaited<ReturnType<QueryCtx['auth']['getUserIdentity']>>>;
}

/**
 * Get the user ID from the session, throwing if not authenticated.
 * Lightweight helper for read-only queries that don't need role information.
 *
 * @param ctx - Convex query or mutation context
 * @returns The BetterAuth user ID
 * @throws Error if not authenticated
 */
export async function getUserIdFromSession(ctx: QueryCtx | MutationCtx): Promise<string> {
	const session = await getBetterAuthSession(ctx);

	if (!session) {
		throwUnauthenticated();
	}

	return session.userId;
}

/**
 * Self-access gate: confirm the caller's session user matches the `userId`
 * argument a self-service endpoint was asked to act on, returning that id.
 *
 * Throws `unauthenticated` (401) on no session (via
 * {@link getUserIdFromSession}). An authenticated caller asking to act on a
 * *different* user's id is `forbidden` (403) — they're authenticated, just not
 * authorized for that target; the security outcome (request rejected) is
 * unchanged, this only corrects the error taxonomy. Use this only for
 * endpoints keyed by the caller's *own* user id; org-scoped writes should go
 * through `getMutationContext` / `requireOrgMember` instead.
 */
export async function requireSelf(
	ctx: QueryCtx | MutationCtx,
	claimedUserId: string
): Promise<string> {
	const sessionUserId = await getUserIdFromSession(ctx);
	if (claimedUserId !== sessionUserId) {
		throwForbidden('You can only act on your own account');
	}
	return sessionUserId;
}

/**
 * Load the `userProfiles` row owned by a given BetterAuth user id via the
 * `by_auth_user_id` index. Returns `null` when no profile exists so callers
 * keep their own not-found policy (some throw `notFound`, some return `null`).
 *
 * Pair with {@link requireSelf} when the id must be the caller's own.
 */
export async function loadOwnUserProfile(
	ctx: QueryCtx | MutationCtx,
	authUserId: string
): Promise<Doc<'userProfiles'> | null> {
	return ctx.db
		.query('userProfiles')
		.withIndex('by_auth_user_id', (q) => q.eq('authUserId', authUserId))
		.first();
}

/**
 * Get full mutation context including user ID and role from the session.
 * This is the primary helper for session-based mutations.
 *
 * @param ctx - Convex mutation context
 * @returns Mutation context with userId and role
 * @throws Error if not authenticated, no active organization, or not a member
 *
 * @example
 * ```typescript
 * export const createFromSession = authedMutation({
 *   args: { name: v.string() },
 *   handler: async (ctx, args) => {
 *     const session = await getMutationContext(ctx);
 *     // session.userId, session.role are available
 *
 *     requirePermission(hasPermission(session.role, 'contacts:manage'), 'Only owners/admins can create contacts');
 *   }
 * });
 * ```
 */
export async function getMutationContext(ctx: MutationCtx): Promise<MutationSessionContext> {
	return requireOrgMember(ctx);
}

/**
 * Require an authenticated **organization member** (active org + role) for a
 * query OR mutation, returning `{ userId, role }`. This is the shared
 * membership floor: it rejects anonymous callers, logged-in users with no
 * active organization, and — critically — authenticated identities that are not
 * members of this single-org deployment (e.g. a self-registered account created
 * via open sign-up, mid-invitation before acceptance, or a former member whose
 * role was revoked).
 *
 * `authedQuery` and `authedMutation` both floor on this so a bare session is
 * never enough to read or write org data; only `authedIdentityMutation` (the
 * signup-bootstrap escape hatch) and the explicit `publicQuery`/`publicMutation`
 * opt-outs sit below it.
 *
 * @throws unauthenticated if no session; forbidden if no active org / not a member.
 */
export async function requireOrgMember(
	ctx: QueryCtx | MutationCtx
): Promise<MutationSessionContext> {
	const sessionWithRole = await getBetterAuthSessionWithRole(ctx);

	if (!sessionWithRole) {
		throwUnauthenticated();
	}

	if (!sessionWithRole.activeOrganizationId) {
		throwForbidden('No active organization. Please select an organization.');
	}

	if (!sessionWithRole.role) {
		throwForbidden('You do not have access to this organization');
	}

	return {
		userId: sessionWithRole.userId,
		role: sessionWithRole.role,
	};
}

/**
 * Soft organization-membership check for `publicQuery` reads that intentionally
 * soft-fail (return empty/null) for anonymous or non-member callers instead of
 * throwing. Returns `true` only for an authenticated active member of this
 * deployment's org. Use as `if (!(await isActiveOrgMember(ctx))) return [];` —
 * the secure replacement for the bare `if (!identity) return []` pattern, which
 * leaked org data to any authenticated identity (member or not).
 */
export async function isActiveOrgMember(ctx: QueryCtx | MutationCtx): Promise<boolean> {
	const session = await getBetterAuthSessionWithRole(ctx);
	return !!session?.role;
}

/**
 * Require a specific permission for the current user.
 * Throws an error if the permission check fails.
 *
 * @param hasPermission - Boolean result of permission check
 * @param message - Error message to show if permission denied
 * @throws Error if permission is denied
 */
export function requirePermission(
	hasPermission: boolean,
	message: string = "You don't have permission to perform this action"
): asserts hasPermission {
	if (!hasPermission) {
		throwForbidden(message);
	}
}

// isAdminRole / isOwnerRole removed — use `hasPermission(role, '<scope>:<verb>')`
// from the Permission union below. See CONVENTIONS.md.

// ============== Permission System ==============

export type Permission =
	// Marketing send pipeline
	| 'campaigns:send'
	| 'campaigns:manage'
	| 'campaigns:schedule'
	// Content authoring
	| 'templates:manage'
	| 'automations:manage'
	| 'topics:manage'
	| 'segments:manage'
	| 'media:manage'
	| 'shareLinks:manage'
	| 'imports:manage'
	// CRM
	| 'contacts:manage'
	// Org + admin
	| 'organization:manage'
	| 'settings:manage'
	| 'organization:delete'
	// Self-service
	| 'emails:test'
	// Read the org knowledge graph (any member) — quick-query / agent context
	| 'knowledge:read'
	// Internal team chat
	| 'chat:participate'
	| 'chat:manage';

const isAdmin = (role: OrganizationRole) => role === 'owner' || role === 'admin';
const isOwner = (role: OrganizationRole) => role === 'owner';
// Any org member (owner, admin, or editor). Editors run the marketing send
// pipeline end-to-end now that the campaign-sender guardrail exists (2026-07-10
// experience plan, decision 8): they may create/edit/schedule/send campaigns,
// but only from the curated `campaignSenders` list (or, if an admin has enabled
// the custom-senders toggle, any verified sending domain). Curating that list
// and flipping the toggle stay admin-only — see `campaigns/senders.ts`.
const isEditorOrAbove = (role: OrganizationRole) =>
	role === 'owner' || role === 'admin' || role === 'editor';

const PERMISSION_MAP: Record<Permission, (role: OrganizationRole) => boolean> = {
	'campaigns:send': isEditorOrAbove,
	'campaigns:manage': isEditorOrAbove,
	'campaigns:schedule': isEditorOrAbove,
	'templates:manage': isAdmin,
	'automations:manage': isAdmin,
	'topics:manage': isAdmin,
	'segments:manage': isAdmin,
	'media:manage': isAdmin,
	'shareLinks:manage': isAdmin,
	'imports:manage': isAdmin,
	'contacts:manage': isAdmin,
	'organization:manage': isAdmin,
	'settings:manage': isAdmin,
	'organization:delete': isOwner,
	'emails:test': () => true,
	'knowledge:read': () => true,
	'chat:participate': () => true,
	'chat:manage': isAdmin,
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: OrganizationRole, permission: Permission): boolean {
	return PERMISSION_MAP[permission](role);
}

/**
 * Get mutation context and assert admin-level role via the typed permission
 * system (`organization:manage`).
 *
 * @example
 * ```typescript
 * export const create = authedMutation({
 *   args: { name: v.string() },
 *   handler: async (ctx, args) => {
 *     const session = await requireAdminContext(ctx);
 *     // session.userId, session.role are available
 *   }
 * });
 * ```
 */
export async function requireAdminContext(
	ctx: MutationCtx,
	message: string = 'Only owners and admins can perform this action'
): Promise<MutationSessionContext> {
	const session = await getMutationContext(ctx);
	requirePermission(hasPermission(session.role, 'organization:manage'), message);
	return session;
}

/**
 * Get mutation context and assert owner role via the typed permission system
 * (`organization:delete`).
 */
export async function requireOwnerContext(
	ctx: MutationCtx,
	message: string = 'Only owners can perform this action'
): Promise<MutationSessionContext> {
	const session = await getMutationContext(ctx);
	requirePermission(hasPermission(session.role, 'organization:delete'), message);
	return session;
}

/**
 * Query/mutation-compatible permission gate. Requires an authenticated
 * organization member AND a specific typed permission. Unlike
 * `requireAdminContext`/`requireOwnerContext` (mutation-only, since they wrap
 * `getMutationContext`) this accepts a `QueryCtx` too, so admin-gated **reads**
 * (e.g. listing API keys / webhook secrets) can use the same typed-permission
 * vocabulary instead of an ad-hoc inline role check.
 *
 * @throws unauthenticated if no session, forbidden if no active org / not a
 *   member / lacks the permission.
 */
export async function requireOrgPermission(
	ctx: QueryCtx | MutationCtx,
	permission: Permission,
	message: string = "You don't have permission to perform this action"
): Promise<MutationSessionContext> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!session) {
		throwUnauthenticated();
	}
	if (!session.activeOrganizationId) {
		throwForbidden('No active organization. Please select an organization.');
	}
	if (!session.role) {
		throwForbidden('You do not have access to this organization');
	}
	requirePermission(hasPermission(session.role, permission), message);
	return { userId: session.userId, role: session.role };
}
