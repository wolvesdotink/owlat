import { betterAuth } from 'better-auth';
import { organization, oneTimeToken } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { getOptional, getRequired } from '../lib/env';
import {
	defaultStatements,
	adminAc,
	ownerAc,
	memberAc,
} from 'better-auth/plugins/organization/access';
import { createClient } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { components, internal } from '../_generated/api';
import type { DataModel } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
// NOTE: `auth.config.ts` must live at the convex root under exactly that name —
// it is Convex's instance auth configuration, evaluated at push time to
// register the JWT provider. Nesting it into a domain folder (as `auth/config.ts`)
// silently strips ALL auth providers from freshly-pushed deployments: sessions
// still work (BetterAuth plane) but every `ctx.auth.getUserIdentity()` returns
// null and every authed query throws "Not authenticated".
import authConfig from '../auth.config';
import { isDevDeployment } from '../devShortcuts/_guard';
import {
	generateInvitationEmailHtml,
	generateInboxInviteEmailHtml,
	generatePasswordResetEmailHtml,
	generateChangeEmailVerificationHtml,
	generateNewEmailVerificationHtml,
} from '../lib/systemEmails';

// Custom access control to use 'editor' instead of 'member'
// This matches the legacy team role system
const statement = { ...defaultStatements } as const;
const ac = createAccessControl(statement);

// Define custom roles - 'editor' has same permissions as BetterAuth's 'member'
const owner = ac.newRole({ ...ownerAc.statements });
const admin = ac.newRole({ ...adminAc.statements });
const editor = ac.newRole({ ...memberAc.statements });

// Create the auth component client using Convex components
// The local betterAuth component (./betterAuth/convex.config.ts) includes
// organization plugin tables for full organization support
export const authComponent = createClient<DataModel>(components.betterAuth);

// Factory function to create auth options (used by adapter)
export const createAuthOptions = (ctx: ActionCtx) => {
	// Auth emails send through the configured system transport (Send system email
	// module), which routes to whatever delivery provider is set up (MTA / Resend
	// / SES) — so auth mail no longer hard-requires the built-in MTA. Closes over
	// the action ctx so the four hooks below stay unchanged.
	const sendViaMta = (params: { to: string; from: string; subject: string; html: string }) =>
		ctx.runAction(internal.systemMail.sendSystemEmail, params);
	return {
		// Cast required: BetterAuth component bundles its own copy of Convex types
		// which are structurally identical but nominally different (bun duplicate resolution)
		database: authComponent.adapter(ctx as Parameters<typeof authComponent.adapter>[0]),
		// Fail closed: an unset secret makes BetterAuth fall back to a built-in,
		// publicly-known default, which would let anyone forge session cookies.
		// Real deploys always set it (quickstart generates it); this throws loudly
		// on a misconfigured deploy instead of silently signing with a weak key.
		// Lazy getter: the betterAuth component calls createAuthOptions at import
		// time purely to derive its table schema, and Convex components cannot see
		// deployment env vars — an eager getRequired there fails module analysis
		// on every push. Reading on first access keeps the fail-closed throw for
		// real auth flows (app context, env available) without breaking the push.
		get secret() {
			return getRequired('BETTER_AUTH_SECRET');
		},
		baseURL: getOptional('SITE_URL'),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 10,
			maxPasswordLength: 128,
			sendResetPassword: async ({
				user,
				token,
			}: {
				user: { name?: string; email: string };
				token: string;
			}) => {
				const siteUrl = getOptional('SITE_URL') || 'http://localhost:3000';
				const fromDomain = getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app';
				const resetUrl = `${siteUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;

				const html = generatePasswordResetEmailHtml(user.name || user.email, resetUrl);

				await sendViaMta({
					to: user.email,
					from: `Owlat <noreply@${fromDomain}>`,
					subject: 'Reset your password — Owlat',
					html,
				});
			},
		},
		user: {
			// Let signed-in users change the email they log in with.
			//
			// updateEmailWithoutVerification stays FALSE so a session holder can
			// never relocate the login identity to an address they don't control:
			// the change only lands after a confirmation link sent to an owned
			// inbox is followed (fail-closed), matching the password-reset trust
			// model.
			//
			// BetterAuth gates the two flows on emailVerified:
			//  - Verified accounts (the seeded owner) take the two-hop path:
			//    sendChangeEmailConfirmation emails the CURRENT address; following
			//    that link triggers emailVerification.sendVerificationEmail to the
			//    NEW address, and following THAT link finally commits the change.
			//  - Unverified accounts (invited members who sign up without a
			//    verification flow) skip the first hop and go straight to
			//    emailVerification.sendVerificationEmail on the NEW address; the
			//    change only lands once that link is followed. With
			//    updateEmailWithoutVerification:false they no longer change
			//    silently and immediately.
			// Both emailVerification.sendVerificationEmail hops are required for
			// the email to ever actually change.
			changeEmail: {
				enabled: true,
				updateEmailWithoutVerification: false,
				sendChangeEmailConfirmation: async ({
					user,
					newEmail,
					url,
				}: {
					user: { name?: string; email: string };
					newEmail: string;
					url: string;
				}) => {
					const fromDomain = getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app';

					const html = generateChangeEmailVerificationHtml(user.name || user.email, newEmail, url);

					await sendViaMta({
						// Sent to the CURRENT address on file, not the new one.
						to: user.email,
						from: `Owlat <noreply@${fromDomain}>`,
						subject: 'Confirm your new email — Owlat',
						html,
					});
				},
			},
		},
		emailVerification: {
			// Final hop of the change-email flow. BetterAuth invokes this with
			// `user.email` already set to the NEW address, so the verification
			// link is delivered to the address being claimed. Following it is
			// what actually commits the new login email (and marks it verified).
			// Without this block BetterAuth dead-ends after the current-address
			// approval and the email never changes — so the verified owner could
			// not change their login email at all.
			sendVerificationEmail: async ({
				user,
				url,
			}: {
				user: { name?: string; email: string };
				url: string;
			}) => {
				const fromDomain = getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app';

				const html = generateNewEmailVerificationHtml(user.name || user.email, user.email, url);

				await sendViaMta({
					// Sent to the NEW address (user.email is the claimed one here).
					to: user.email,
					from: `Owlat <noreply@${fromDomain}>`,
					subject: 'Verify your new login email — Owlat',
					html,
				});
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 3, // 3 days
			updateAge: 60 * 60 * 12, // Update session every 12 hours
			cookieCache: {
				enabled: true,
				maxAge: 5 * 60, // 5 minutes
			},
		},
		rateLimit: {
			// BetterAuth's built-in limiter keys on the client IP (first entry of
			// X-Forwarded-For). Production deployments get that header from the
			// fronting proxy (Caddy, and the web app's /api/auth proxy extends the
			// chain). Traffic that reaches a DEV deployment directly (the desktop
			// app in `tauri dev`, curl against :3211) carries no such header, so
			// the limiter would skip every request and log a WARN each time —
			// disable it where OWLAT_DEV_MODE is set, keep the default elsewhere.
			enabled: !isDevDeployment(),
		},
		trustedOrigins: (() => {
			const adminSiteUrl = getOptional('ADMIN_SITE_URL');
			return [
				getOptional('SITE_URL') || 'http://localhost:3000',
				adminSiteUrl ?? 'http://localhost:3001',
				// Desktop app (Tauri) origins. The packaged webview serves the
				// bundled SPA from these origins and talks to this instance
				// cross-origin via the cross-domain plugin (header-based session,
				// no cookies). See apps/web/app/lib/auth-client.ts (desktop branch).
				'tauri://localhost',
				'https://tauri.localhost',
			];
		})(),
		plugins: [
			// Cross-domain plugin: enables cookieless, cross-origin auth for the
			// Tauri desktop app. It rewrites the `Better-Auth-Cookie` request
			// header into a real cookie before session resolution and moves
			// `Set-Cookie` into `Set-Better-Auth-Cookie` on responses, and exposes
			// the one-time-token verify endpoint the desktop handshake redeems.
			// Must precede `convex` so its before-hook resolves the session that
			// `/convex/token` then mints a JWT from.
			crossDomain({ siteUrl: getOptional('SITE_URL') || 'http://localhost:3000' }),
			// One-time token: the /desktop/connect browser page mints a short-lived
			// token (bound to the just-authenticated session) that it hands back to
			// the desktop app via the `owlat://auth?ott=` deep link.
			oneTimeToken(),
			// Convex plugin provides /convex/token and /convex/jwks endpoints
			// Required for Convex client authentication via JWT
			convex({
				authConfig,
				jwt: {
					definePayload: ({ user, session }) => {
						const { id: _id, image: _image, ...claims } = user;

						return {
							...claims,
							activeOrganizationId: session['activeOrganizationId'] ?? null,
						};
					},
				},
			}),
			organization({
				// Custom access control with 'editor' role instead of 'member'
				ac,
				roles: { owner, admin, editor },
				// Single-org-per-instance: the one org is bootstrapped by the
				// /seed/admin HTTP action (apps/api/convex/seedAdmin.ts) which
				// writes through the BetterAuth adapter directly. The public
				// `auth/organization/create` endpoint stays disabled so users
				// cannot create additional orgs and silently merge data with
				// the existing tenant.
				allowUserToCreateOrganization: false,
				// Default role for organization creator
				creatorRole: 'owner',
				// Maximum members per organization (reasonable limit)
				membershipLimit: 50,
				// Invitation expiration: 7 days (in seconds)
				invitationExpiresIn: 60 * 60 * 24 * 7,
				// Email invitation handler - sends invitation emails via own MTA
				sendInvitationEmail: async ({ email, organization: org, inviter, invitation }) => {
					// Single enforcement choke point for the 1/min-per-invite floor.
					// Every send path — first invite, cooperating-client resend, and a
					// raw `invite-member` API call with resend:true — routes through
					// this hook, so the throttle can't be bypassed. Throws (and thus
					// skips the send) when inside the cooldown; stamps otherwise.
					await ctx.runMutation(internal.auth.invitationResend.enforceResendThrottle, {
						invitationId: invitation.id,
						organizationId: org.id,
					});

					const siteUrl = getOptional('SITE_URL') || 'http://localhost:3000';
					const fromDomain = getOptional('DEFAULT_FROM_DOMAIN') || 'mail.owlat.app';

					// Build accept URL - BetterAuth uses the invitation ID
					const acceptUrl = `${siteUrl}/invite/accept?id=${encodeURIComponent(invitation.id)}`;

					// If this invitee was pre-added to a team inbox (reserved before the
					// invite was issued), name the inbox in the email and waiting
					// membership; otherwise send the generic org invite.
					const inboxContext = await ctx.runQuery(
						internal.mail.pendingInboxMembership.inboxInviteContextForEmail,
						{ organizationId: org.id, email }
					);

					const inviterDisplayName = inviter.user.name || inviter.user.email;
					const html = inboxContext
						? generateInboxInviteEmailHtml(
								org.name,
								inviterDisplayName,
								inviter.user.email,
								inboxContext.inboxAddress,
								acceptUrl
							)
						: generateInvitationEmailHtml(
								org.name,
								inviterDisplayName,
								inviter.user.email,
								acceptUrl,
								invitation.role
							);

					await sendViaMta({
						to: email,
						from: `Owlat <noreply@${fromDomain}>`,
						subject: inboxContext
							? `${inviterDisplayName} invited you to ${inboxContext.inboxAddress}`
							: `You're invited to join ${org.name} on Owlat`,
						html,
					});
				},
			}),
		],
	};
};

// Factory function to create auth instance with proper context
export const createAuth = (ctx: ActionCtx) => {
	return betterAuth(createAuthOptions(ctx));
};
