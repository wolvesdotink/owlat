import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { ActionCtx, MutationCtx, QueryCtx } from '../_generated/server';
import { components, internal } from '../_generated/api';
import { adminMutation, authedAction } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { recordAuditLog } from '../lib/auditLog';
import { throwNotFound } from '../_utils/errors';
import { betterAuthAdapterArgs } from '../lib/betterAuthAdapterArgs';
import { createAuth } from './auth';

/**
 * Admin recovery for the email-verification gate (H3).
 *
 * When `REQUIRE_EMAIL_VERIFICATION` is on, an unverified account cannot sign in —
 * BetterAuth sends a verification link instead. If that link never lands (mail
 * outage, wrong provider, the account predates verification), the member is
 * stranded with no self-service way out. These two owner/admin-gated paths are
 * the escape hatch:
 *
 *   - `markMemberEmailVerified` — flip a member's `emailVerified` to true
 *     out-of-band (the operator has confirmed identity by other means).
 *   - `resendMemberVerificationEmail` — re-send the verification link through the
 *     same BetterAuth `sendVerificationEmail` route a signup uses.
 *
 * Both FAIL CLOSED and are ORG-SCOPED: the target must be a member of the
 * caller's active organization (single-org-per-deployment), and only an
 * `organization:manage` (owner/admin) caller may run them. A cross-org or unknown
 * target resolves to "not found" rather than acting on a stranger's account.
 */

const ERROR_TARGET_NOT_MEMBER = 'Organization member';

type MemberUser = { email: string; emailVerified: boolean };

/**
 * Resolve a BetterAuth user by id ONLY when they are a member of the given
 * organization. Returns `null` (caller throws not-found) when the target is not a
 * member or the user row is missing — so an admin can never reach across the
 * single-org boundary to verify or re-mail an account that is not theirs to
 * manage. Reads through the component adapter (queries may `ctx.runQuery` the
 * component, same as `getBetterAuthSessionWithRole`).
 */
async function loadOrgMemberUser(
	ctx: QueryCtx | MutationCtx,
	organizationId: string,
	targetUserId: string
): Promise<MemberUser | null> {
	const member = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'member',
		where: [
			{ field: 'organizationId', value: organizationId },
			{ field: 'userId', value: targetUserId },
		],
	})) as { userId?: string } | null;
	if (!member) return null;

	const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
		model: 'user',
		where: [{ field: '_id', value: targetUserId }],
	})) as { email?: string; emailVerified?: boolean } | null;
	if (!user?.email) return null;

	return { email: user.email, emailVerified: Boolean(user.emailVerified) };
}

/**
 * Owner/admin escape hatch: mark a stranded member's email verified so they can
 * sign in again. Idempotent — a member who is already verified is a no-op (no
 * duplicate audit row). Org-scoped via `loadOrgMemberUser`.
 */
export const markMemberEmailVerified = adminMutation({
	args: { userId: v.string() },
	handler: async (ctx: MutationCtx, { userId }: { userId: string }, session) => {
		const target = await loadOrgMemberUser(ctx, session.activeOrganizationId, userId);
		if (!target) {
			throwNotFound(ERROR_TARGET_NOT_MEMBER);
		}
		if (target.emailVerified) {
			return { alreadyVerified: true, email: target.email };
		}

		await ctx.runMutation(
			components.betterAuth.adapter.updateOne,
			betterAuthAdapterArgs({
				input: {
					model: 'user',
					update: { emailVerified: true, updatedAt: Date.now() },
					where: [{ field: '_id', value: userId }],
				},
			})
		);

		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'team_member.email_verified',
			resource: 'team_member',
			resourceId: userId,
			details: { email: target.email },
		});

		return { alreadyVerified: false, email: target.email };
	},
});

/**
 * Admin gate + org-scoped target resolution for the resend action. Runs inside a
 * query so it can enforce `organization:manage` (via the caller's session) and
 * read the target member through the component adapter; the action calls it
 * before it ever touches BetterAuth, so a non-admin / cross-org caller is
 * rejected before any mail is generated. Returns the target's email plus the
 * acting admin's identity for the audit row.
 */
export const resolveMemberForResend = internalQuery({
	args: { userId: v.string() },
	handler: async (ctx, { userId }) => {
		const session = await requireOrgPermission(
			ctx,
			'organization:manage',
			'Only owners and admins can resend a member verification email'
		);
		const target = await loadOrgMemberUser(ctx, session.activeOrganizationId, userId);
		if (!target) {
			throwNotFound(ERROR_TARGET_NOT_MEMBER);
		}
		return {
			email: target.email,
			alreadyVerified: target.emailVerified,
			actorUserId: session.userId,
			organizationId: session.activeOrganizationId,
		};
	},
});

/**
 * Owner/admin escape hatch: re-send the verification link to a stranded member
 * via BetterAuth's own `sendVerificationEmail` route (the same path a fresh
 * signup uses), which routes the mail through the configured system transport.
 * An already-verified member is a no-op (BetterAuth will not re-mail a verified
 * address, and we skip the call). Org-scoped + admin-gated by
 * `resolveMemberForResend`, which runs first.
 */
// authz: delegated — resolveMemberForResend enforces organization:manage + org
// scoping before BetterAuth is touched; an action cannot run the DB gate itself.
// (authedAction adds the member floor; the internal query adds the admin floor.)
export const resendMemberVerificationEmail = authedAction({
	args: { userId: v.string() },
	handler: async (
		ctx: ActionCtx,
		{ userId }: { userId: string }
	): Promise<{ sent: boolean; email: string }> => {
		const target = await ctx.runQuery(internal.auth.emailVerificationAdmin.resolveMemberForResend, {
			userId,
		});
		if (target.alreadyVerified) {
			return { sent: false, email: target.email };
		}

		// Generates a fresh verification token and delivers it through the
		// configured system-mail transport (systemMail.sendSystemEmail), which
		// FAIL-CLOSED throws if no provider is configured.
		const auth = createAuth(ctx);
		await auth.api.sendVerificationEmail({ body: { email: target.email } });

		await ctx.runMutation(internal.auth.emailVerificationAdmin.recordResendAudit, {
			actorUserId: target.actorUserId,
			organizationId: target.organizationId,
			targetUserId: userId,
			email: target.email,
		});

		return { sent: true, email: target.email };
	},
});

/**
 * Audit sink for the resend action (actions cannot write the DB). Internal-only:
 * the action has already enforced the admin + org-scope gate via
 * `resolveMemberForResend` and passes through the resolved actor/target.
 */
export const recordResendAudit = internalMutation({
	args: {
		actorUserId: v.string(),
		organizationId: v.string(),
		targetUserId: v.string(),
		email: v.string(),
	},
	handler: async (ctx, args) => {
		await recordAuditLog(ctx, {
			userId: args.actorUserId,
			organizationId: args.organizationId,
			action: 'team_member.verification_resent',
			resource: 'team_member',
			resourceId: args.targetUserId,
			details: { email: args.email },
		});
	},
});
