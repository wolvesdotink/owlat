import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requirePlatformAdmin } from './platformAdmin';
import { throwNotFound, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { recordAuditLog } from '../lib/auditLog';
import { abuseStatusValidator } from '../workspaces/abuseStatus';

// Authorization model: every mutation here is an `authedMutation` (session
// floor) whose handler first calls `requirePlatformAdmin(ctx)` — FORBIDDEN
// unless the caller is in the `platformAdmins` table — and superadmin-only
// operations additionally check `role === 'superadmin'`. On OSS self-host that
// table is never populated by any production path, so these mutations are
// reachable in code but INERT at runtime. This is intentional (control-plane-
// only); see platformAdmin.ts for the full rationale and the separate Nest repo.

// ============ ORGANIZATION STATUS MANAGEMENT ============

/**
 * Set the abuse status of an organization.
 * Used by platform admins to warn, suspend, or ban organizations.
 *
 * Per ADR-0011 this routes through `abuseStatus.adminOverride`, which
 * bypasses the severity rules that gate internal writers — admins can
 * demote a `banned` org to `clean` for appeal resolution. The
 * `abuse_status_changed` audit log fires inside the lifecycle module;
 * the legacy `platform_admin.org_status_changed` row stays for
 * compatibility with existing platform-admin UI queries that filter by
 * that literal.
 */
export const setOrganizationStatus = authedMutation({
	args: {
		abuseStatus: abuseStatusValidator,
		reason: v.string(),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);

		const settings = await ctx.db.query('instanceSettings').first();

		if (!settings) {
			throwNotFound('Organization');
		}

		const previousStatus = settings.abuseStatus || 'clean';

		const outcome = await ctx.runMutation(internal.workspaces.abuseStatus.adminOverride, {
			input: {
				to: args.abuseStatus,
				at: Date.now(),
				reason: args.reason,
				changedBy: admin.authUserId,
			},
		});

		if (!outcome.ok) {
			throwInvalidState(`Cannot set abuse status: ${outcome.reason}`);
		}

		// Legacy platform-admin-specific audit entry (the lifecycle module
		// emits `abuse_status_changed`; this preserves the
		// `platform_admin.org_status_changed` filter used by the admin UI).
		await recordAuditLog(ctx, {
			userId: admin.authUserId,
			action: 'platform_admin.org_status_changed',
			resource: 'platform_admin',
			resourceId: 'instance',
			details: {
				previousStatus,
				newStatus: args.abuseStatus,
				reason: args.reason,
			},
		});

		return { success: true, previousStatus, newStatus: args.abuseStatus };
	},
});

// ============ CONTENT APPROVAL ============

/**
 * Approve a campaign that is pending review.
 * Transitions the campaign back to draft so the user can send it.
 */
export const approveCampaign = authedMutation({
	args: {
		campaignId: v.id('campaigns'),
		notes: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);

		const campaign = await ctx.db.get(args.campaignId);
		if (!campaign) {
			throwNotFound('Campaign');
		}

		if (campaign.status !== 'pending_review') {
			throwInvalidInput('Campaign is not pending review');
		}

		const now = Date.now();

		await ctx.db.patch(args.campaignId, {
			status: 'draft',
			updatedAt: now,
		});

		// Log the approval
		await recordAuditLog(ctx, {
			userId: admin.authUserId,
			action: 'platform_admin.content_approved',
			resource: 'platform_admin',
			resourceId: args.campaignId,
			details: {
				type: 'campaign',
				name: campaign.name,
				notes: args.notes ?? null,
			},
		});

		return { success: true };
	},
});

/**
 * Approve a transactional email that is pending review.
 * Transitions it to published status.
 */
export const approveTransactional = authedMutation({
	args: {
		transactionalEmailId: v.id('transactionalEmails'),
		notes: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);

		const email = await ctx.db.get(args.transactionalEmailId);
		if (!email) {
			throwNotFound('Transactional email');
		}

		if (email.status !== 'pending_review') {
			throwInvalidInput('Transactional email is not pending review');
		}

		const now = Date.now();

		await ctx.db.patch(args.transactionalEmailId, {
			status: 'published',
			publishedAt: now,
		});

		// Log the approval
		await recordAuditLog(ctx, {
			userId: admin.authUserId,
			action: 'platform_admin.content_approved',
			resource: 'platform_admin',
			resourceId: args.transactionalEmailId,
			details: {
				type: 'transactional',
				name: email.name,
				slug: email.slug,
				notes: args.notes ?? null,
			},
		});

		return { success: true };
	},
});

/**
 * Reject content that is pending review.
 * Works for both campaigns and transactional emails.
 */
export const rejectContent = authedMutation({
	args: {
		resourceType: v.union(v.literal('campaign'), v.literal('transactional')),
		resourceId: v.string(),
		reason: v.string(),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);
		const now = Date.now();

		if (args.resourceType === 'campaign') {
			const campaign = await ctx.db.get(args.resourceId as Id<'campaigns'>);
			if (!campaign) {
				throwNotFound('Campaign');
			}

			if (campaign.status !== 'pending_review') {
				throwInvalidInput('Campaign is not pending review');
			}

			// Revert to draft with rejection info
			await ctx.db.patch(campaign._id, {
				status: 'draft',
				updatedAt: now,
			});

			await recordAuditLog(ctx, {
				userId: admin.authUserId,
				action: 'platform_admin.content_rejected',
				resource: 'platform_admin',
				resourceId: args.resourceId,
				details: {
					type: 'campaign',
					name: campaign.name,
					reason: args.reason,
				},
			});
		} else {
			const email = await ctx.db.get(args.resourceId as Id<'transactionalEmails'>);
			if (!email) {
				throwNotFound('Transactional email');
			}

			if (email.status !== 'pending_review') {
				throwInvalidInput('Transactional email is not pending review');
			}

			// Revert to draft
			await ctx.db.patch(email._id, {
				status: 'draft',
			});

			await recordAuditLog(ctx, {
				userId: admin.authUserId,
				action: 'platform_admin.content_rejected',
				resource: 'platform_admin',
				resourceId: args.resourceId,
				details: {
					type: 'transactional',
					name: email.name,
					reason: args.reason,
				},
			});
		}

		return { success: true };
	},
});

// ============ ADMIN MANAGEMENT ============

/**
 * Add a new platform admin (superadmin only).
 */
export const addPlatformAdmin = authedMutation({
	args: {
		authUserId: v.string(),
		email: v.string(),
		role: v.union(v.literal('admin'), v.literal('superadmin')),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);

		// Only superadmins can add other admins
		if (admin.role !== 'superadmin') {
			throwInvalidInput('Only superadmins can add new platform admins');
		}

		// Check if already exists
		const existing = await ctx.db
			.query('platformAdmins')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();

		if (existing) {
			throwInvalidInput('User is already a platform admin');
		}

		// Resolve the user against the canonical profile rather than trusting the
		// caller-supplied authUserId/email — refuse to grant platform-admin to a
		// non-existent user, and store the profile's email (not the request's).
		const profile = await ctx.db
			.query('userProfiles')
			.withIndex('by_auth_user_id', (q) => q.eq('authUserId', args.authUserId))
			.first();
		if (!profile) {
			throwNotFound('User');
		}

		const adminId = await ctx.db.insert('platformAdmins', {
			authUserId: args.authUserId,
			email: profile.email,
			role: args.role,
			createdAt: Date.now(),
		});

		// A privilege grant must be auditable, mirroring admin_removed.
		await recordAuditLog(ctx, {
			userId: admin.authUserId,
			action: 'platform_admin.admin_added',
			resource: 'platform_admin',
			resourceId: adminId,
			details: {
				email: profile.email,
				role: args.role,
				addedBy: admin.authUserId,
			},
		});

		return adminId;
	},
});

/**
 * Remove a platform admin (superadmin only).
 * Cannot remove yourself.
 */
export const removePlatformAdmin = authedMutation({
	args: {
		adminId: v.id('platformAdmins'),
	},
	handler: async (ctx, args) => {
		const admin = await requirePlatformAdmin(ctx);

		// Only superadmins can remove admins
		if (admin.role !== 'superadmin') {
			throwInvalidInput('Only superadmins can remove platform admins');
		}

		const targetAdmin = await ctx.db.get(args.adminId);
		if (!targetAdmin) {
			throwNotFound('Platform admin');
		}

		// Cannot remove yourself
		if (targetAdmin.authUserId === admin.authUserId) {
			throwInvalidInput('Cannot remove yourself as platform admin');
		}

		await ctx.db.delete(args.adminId);

		// Log the action
		await recordAuditLog(ctx, {
			userId: admin.authUserId,
			action: 'platform_admin.admin_removed',
			resource: 'platform_admin',
			resourceId: args.adminId,
			details: {
				email: targetAdmin.email,
				role: targetAdmin.role,
			},
		});

		return { success: true };
	},
});
