/**
 * Secure-by-default Convex function builders.
 *
 * Convex publishes **every** non-`internal` `query` / `mutation` / `action` on
 * the deployment's public client API — any anonymous internet caller who knows
 * the deployment URL can invoke them. Reaching for the bare `query` / `mutation`
 * / `action` builders therefore means "I have personally verified this is safe
 * to expose unauthenticated", which is almost never true.
 *
 * To make the safe path the default, all public functions go through one of the
 * builders below instead of the raw `_generated/server` ones:
 *
 *   - `authedQuery`    — requires an authenticated **organization member**
 *                        (active org + role) — the read counterpart to
 *                        `authedMutation`. A bare logged-in session is NOT
 *                        enough (closes the open-signup → org-data-read leak).
 *   - `authedMutation` — requires an authenticated **organization member**
 *                        (active org + role). Privileged writes still layer a
 *                        `requirePermission(hasPermission(role, '<scope>:<verb>'))`
 *                        check on top inside the handler.
 *   - `adminMutation`  — requires an **owner/admin** member (`organization:manage`).
 *                        The role-bearing counterpart to `authedMutation` — the
 *                        floor is "admin", so the handler needs no in-handler
 *                        `requirePermission` for the common admin-only write.
 *   - `ownerMutation`  — requires the **owner** role (`organization:delete`), for
 *                        the few destructive org-level writes even admins can't do.
 *   - `adminQuery`     — admin-gated **read** (sensitive lists like API keys /
 *                        webhook secrets / the shared support inbox). Throws for
 *                        non-admins; soft-failing reads keep `publicQuery` + an
 *                        in-handler role check that returns empty instead.
 *   - `authedAction`   — requires an authenticated **organization member**,
 *                        enforced via the internal `auth.membership.assertOrgMember`
 *                        query (actions can't read the DB directly).
 *   - `publicQuery` / `publicMutation` / `publicAction` — explicit, greppable
 *                        opt-outs for endpoints that are genuinely public by
 *                        design (token-gated share/DOI/unsubscribe links,
 *                        signature-verified webhooks, tracking pixels, the
 *                        pre-auth setup page). Every use must carry a
 *                        `// public: <reason>` comment.
 *
 * The `scripts/check-public-functions.sh` lint (wired into `bun run lint`) bans
 * the bare `query(` / `mutation(` / `action(` builders everywhere except this
 * file, so a forgotten gate fails CI rather than silently shipping an open
 * endpoint.
 *
 * Auth floors intentionally reuse the existing session helpers
 * (`requireOrgMember`, `getMutationContext`, `requireAuthenticatedIdentity`,
 * and the `auth.membership.assertOrgMember` query for actions) so the behaviour
 * — and the way unit tests mock them — is identical to the hand-written checks
 * these wrappers replace. The wrapper only enforces the floor; handlers that
 * need the `userId` / `role` still call the helper themselves (the singleton-org
 * check is process-cached, so the second call is effectively free).
 *
 * The builders are typed as the underlying `typeof query` / `typeof mutation` /
 * `typeof action`, so call sites, the generated `api` surface, and `apps/web`
 * consumers see the exact same signature as the raw builders — the wrapper adds
 * a pre-handler auth check and nothing else (it does not modify `ctx` or
 * `args`).
 *
 * See docs/adr (operation-error-taxonomy) and CONVENTIONS.md § Permissions.
 */

import { query, mutation, action } from '../_generated/server';
import type { QueryCtx, MutationCtx, ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import {
	getMutationContext,
	requireOrgMember,
	requireAuthenticatedIdentity,
	requireAdminContext,
	requireOwnerContext,
	requireOrgPermission,
} from './sessionOrganization';
import { assertFeatureEnabled } from './featureFlags';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';

/**
 * The shape a Convex function builder accepts. Kept deliberately opaque
 * (`unknown` ctx/args) because the wrapper neither inspects nor reshapes them —
 * the precise generic types come back via the `as typeof <builder>` cast on
 * each export, so call sites still get full argument/return inference.
 */
interface FunctionConfig {
	args: Record<string, unknown>;
	returns?: unknown;
	handler: (ctx: never, args: never) => unknown;
}

type RawQuery = typeof query;
type RawMutation = typeof mutation;
type RawAction = typeof action;

/**
 * Public query that requires an authenticated **organization member** (active
 * org + role) — the read counterpart to `authedMutation`. Rejects anonymous
 * callers AND authenticated-but-non-member identities (e.g. a self-registered
 * account from open sign-up, or a user mid-invitation before acceptance) with an
 * `unauthenticated` / `forbidden` Operation error before the handler runs. This
 * is the floor that keeps org data (contacts, mail, knowledge, files, internal
 * chat) from leaking to a bare logged-in session. Reads that must soft-fail for
 * anonymous/non-members (returning empty instead of throwing) stay on
 * `publicQuery` with an in-handler membership check.
 */
export const authedQuery = ((fn: FunctionConfig) =>
	query({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: QueryCtx, args: unknown) => {
			await requireOrgMember(ctx);
			return (fn.handler as unknown as (c: QueryCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawQuery>[0])) as unknown as RawQuery;

/**
 * Public mutation that requires an authenticated organization member (active
 * org + role). Rejects anonymous callers and users with no membership.
 * Privileged writes additionally call
 * `requirePermission(hasPermission(role, '<scope>:<verb>'))` inside the handler.
 */
export const authedMutation = ((fn: FunctionConfig) =>
	mutation({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: MutationCtx, args: unknown) => {
			await getMutationContext(ctx);
			return (fn.handler as unknown as (c: MutationCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawMutation>[0])) as unknown as RawMutation;

/**
 * Public mutation that requires only an authenticated **identity** (not org
 * membership). For the narrow set of writes that must run before a user has an
 * active organization or member role — chiefly account/profile bootstrap during
 * signup. Such handlers must still enforce that the identity matches the record
 * being written (e.g. `identity.subject === args.authUserId`).
 *
 * Prefer `authedMutation` for everything else; this looser floor exists only so
 * the signup path isn't forced through an org-membership check it cannot
 * satisfy yet.
 */
export const authedIdentityMutation = ((fn: FunctionConfig) =>
	mutation({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: MutationCtx, args: unknown) => {
			await requireAuthenticatedIdentity(ctx);
			return (fn.handler as unknown as (c: MutationCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawMutation>[0])) as unknown as RawMutation;

/**
 * Public action that requires an authenticated **organization member**. Actions
 * cannot touch the database directly, so the membership floor is enforced via an
 * internal query (`auth.membership.assertOrgMember`) that inherits the action's
 * identity through `ctx.runQuery` and throws for anonymous callers / non-members
 * before the handler runs. This closes the gap where an `authedAction` (e.g. the
 * org-wide `assistant.ask` knowledge/file Q&A) was reachable by any logged-in
 * identity, not just a member. Per-permission/role checks still happen in the
 * mutations/queries the action calls.
 */
export const authedAction = ((fn: FunctionConfig) =>
	action({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: ActionCtx, args: unknown) => {
			await ctx.runQuery(internal.auth.membership.assertOrgMember, {});
			return (fn.handler as unknown as (c: ActionCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawAction>[0])) as unknown as RawAction;

/**
 * Public mutation that requires an **owner or admin** organization member — the
 * role-bearing counterpart to `authedMutation`. Bakes the `requireAdminContext`
 * (`organization:manage`) check into the wrapper so the floor is "admin", not
 * merely "any member". Prefer this over `authedMutation` + an in-handler
 * `requirePermission(hasPermission(role, 'organization:manage'))` for admin-only
 * writes. Handlers that need `userId` / `role` still call `getMutationContext`
 * (or `requireAdminContext`) themselves, exactly as with `authedMutation`.
 */
export const adminMutation = ((fn: FunctionConfig) =>
	mutation({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: MutationCtx, args: unknown) => {
			await requireAdminContext(ctx);
			return (fn.handler as unknown as (c: MutationCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawMutation>[0])) as unknown as RawMutation;

/**
 * Public mutation that requires the **owner** role (`organization:delete`). For
 * the narrow set of destructive org-level writes (e.g. deleting the
 * organization, rotating the instance secret) that even admins must not perform.
 */
export const ownerMutation = ((fn: FunctionConfig) =>
	mutation({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: MutationCtx, args: unknown) => {
			await requireOwnerContext(ctx);
			return (fn.handler as unknown as (c: MutationCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawMutation>[0])) as unknown as RawMutation;

/**
 * Admin-gated **read**. Requires an owner/admin member (`organization:manage`)
 * before the handler runs — the query counterpart to `adminMutation`, for
 * sensitive reads (API keys, webhook secrets, the shared support inbox) that
 * must not be visible to ordinary members. Throws `forbidden` for non-admins; a
 * soft-failing read that should return empty instead stays on `publicQuery` with
 * an in-handler role check.
 */
export const adminQuery = ((fn: FunctionConfig) =>
	query({
		args: fn.args,
		...(fn.returns !== undefined ? { returns: fn.returns } : {}),
		handler: async (ctx: QueryCtx, args: unknown) => {
			await requireOrgPermission(ctx, 'organization:manage');
			return (fn.handler as unknown as (c: QueryCtx, a: unknown) => unknown)(ctx, args);
		},
	} as Parameters<RawQuery>[0])) as unknown as RawQuery;

/**
 * Compose a **feature-flag floor** onto an existing authed query/mutation
 * builder. Returns a new builder of the exact same type that runs
 * `await assertFeatureEnabled(ctx, flag)` — throwing `forbidden` when the flag
 * is off — *after* the wrapped builder's auth floor and *before* the handler.
 *
 * This bakes the `assertFeatureEnabled(ctx, '<flag>')` call that gated modules
 * used to repeat at the top of every handler into the wrapper, exactly as
 * `adminMutation` / `ownerMutation` bake in their role floor. Per-room /
 * per-record authz (e.g. `assertCanReadRoom`, `chat:manage` role gates) still
 * lives in the handler — this only enforces the module-level feature floor.
 *
 * Only `assertFeatureEnabled` reads `ctx.db`, so only query/mutation builders
 * can be gated this way; feature-gated **actions** keep the in-handler check
 * against a query they call.
 *
 * @example
 *   const chatQuery = featureGated(authedQuery, 'chat');
 *   const chatMutation = featureGated(authedMutation, 'chat');
 */
export function featureGated<Builder extends RawQuery | RawMutation>(
	builder: Builder,
	flag: FeatureFlagKey,
): Builder {
	return ((fn: FunctionConfig) =>
		(builder as unknown as (f: FunctionConfig) => unknown)({
			args: fn.args,
			...(fn.returns !== undefined ? { returns: fn.returns } : {}),
			handler: async (ctx: QueryCtx | MutationCtx, args: unknown) => {
				await assertFeatureEnabled(ctx, flag);
				return (fn.handler as unknown as (c: unknown, a: unknown) => unknown)(ctx, args);
			},
		})) as unknown as Builder;
}

/**
 * Explicit opt-out builders for endpoints that are intentionally reachable by
 * unauthenticated callers (token-gated links, signature-verified webhooks,
 * tracking pixels, the pre-auth setup page). These are plain aliases of the raw
 * builders — their only purpose is to make "this is public on purpose" an
 * explicit, greppable, lint-allowlisted choice rather than the default.
 *
 * Every use MUST carry a `// public: <reason>` comment at the call site.
 */
export const publicQuery = query;
export const publicMutation = mutation;
export const publicAction = action;
