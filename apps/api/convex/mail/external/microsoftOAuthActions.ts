'use node';

/**
 * Microsoft sign-in for external mailboxes — the two public actions.
 *
 * The same two-leg handshake as Google sign-in (`googleOAuthActions.ts`):
 * `start` mints the PKCE pair + `state` nonce, records the intent, and hands
 * back the URL to send the browser to; `complete` is called by the callback PAGE
 * (apps/web `/oauth/microsoft/callback`) with the `code` + `state` Microsoft
 * redirected back with, consumes the state row, trades the code for a refresh
 * token, and lands the grant through the session-bound internal mutations the
 * app-password path uses (`oauthConnect.ts`).
 *
 * No token, code, or client secret is ever logged or returned to the browser.
 */

import dns from 'node:dns/promises';
import { v } from 'convex/values';
import { authedAction } from '../../lib/authedFunctions';
import { internal } from '../../_generated/api';
import { throwInvalidInput } from '../../_utils/errors';
import { STRING_LIMITS, validateStringLength } from '../../lib/inputGuards';
import { oauthIntentValidator } from '../../schema/mailAccounts';
import { assertExternalEnabled } from './externalFeature';
import {
	isMicrosoftConsumerDomain,
	isMicrosoftMxHost,
	isMicrosoftOAuthConfigured,
} from './microsoftOAuth';
import { OAUTH_STATE_TTL_MS, assertSafeReturnTo } from './oauthState';
import { landOAuthGrant, precheckOAuthIntent, toOAuthConnectFields } from './oauthConnect';
import { pkceChallenge, randomUrlSafeToken } from './oauthTokenShared';
import {
	buildMicrosoftAuthorizationUrl,
	exchangeMicrosoftAuthorizationCode,
	microsoftPresetForTenant,
	microsoftRedirectUri,
	requireMicrosoftOAuthClient,
} from './microsoftOAuthTokens';
import type { Id } from '../../_generated/dataModel';

/**
 * Begin a Microsoft authorization. Returns the URL the browser must be sent to.
 *
 * The `intent` is pinned here and stored server-side, so a tampered callback URL
 * cannot change what the consent is used for; the per-intent floor is asserted
 * here as well as in the internal mutation `complete` dispatches to, so a member
 * who cannot perform the intent never reaches Microsoft's consent screen.
 */
// authz: external mailbox connect/reauthorize — authedAction (authenticated member)
// + assertExternalEnabled + the per-intent floor in `precheckOAuthIntent` (admin for
// connectShared/connectSeed, owner/admin via the shared query for updateShared);
// the enforcing copy of each floor lives in the internal mutations `complete`
// dispatches to.
export const start = authedAction({
	args: { intent: oauthIntentValidator, returnTo: v.string() },
	handler: async (ctx, args): Promise<{ authorizationUrl: string }> => {
		await assertExternalEnabled(ctx);
		assertSafeReturnTo(args.returnTo);
		const client = requireMicrosoftOAuthClient();
		const expectedAddress = await precheckOAuthIntent(ctx, args.intent);

		const state = randomUrlSafeToken();
		const codeVerifier = randomUrlSafeToken();
		await ctx.runMutation(internal.mail.external.microsoftOAuth._createStateInternal, {
			state,
			codeVerifier,
			intent: args.intent,
			returnTo: args.returnTo,
			expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
		});

		return {
			authorizationUrl: buildMicrosoftAuthorizationUrl({
				client,
				redirectUri: microsoftRedirectUri(),
				state,
				codeChallenge: pkceChallenge(codeVerifier),
				...(expectedAddress ? { loginHint: expectedAddress } : {}),
			}),
		};
	},
});

/**
 * Finish the authorization the callback page received.
 *
 * Every failure deletes the state row (the consume is unconditional), so a
 * retry always starts a fresh handshake rather than replaying a spent code.
 */
// authz: external mailbox connect/reauthorize — authedAction + assertExternalEnabled;
// the state row is bound to the caller's own session, and each intent dispatches
// to the internal mutation that owns its role floor.
export const complete = authedAction({
	args: { code: v.string(), state: v.string() },
	handler: async (ctx, args): Promise<{ mailboxId: Id<'mailboxes'>; returnTo: string }> => {
		await assertExternalEnabled(ctx);
		// checkpoint: the single-use state is consumed before the code exchange,
		// and stays consumed when the exchange fails: a retry starts a fresh
		// handshake instead of replaying a spent code.
		const stateRow = await ctx.runMutation(
			internal.mail.external.microsoftOAuth._consumeStateInternal,
			{ state: args.state }
		);
		if (!stateRow) throwInvalidInput('This Microsoft sign-in link has expired. Start again.');

		const client = requireMicrosoftOAuthClient();
		const { refreshToken, email, tenantId } = await exchangeMicrosoftAuthorizationCode({
			client,
			code: args.code,
			codeVerifier: stateRow.codeVerifier,
			redirectUri: microsoftRedirectUri(),
		});
		const fields = toOAuthConnectFields({
			provider: 'microsoft',
			preset: microsoftPresetForTenant(tenantId),
			email,
			secret: { oauthRefreshToken: refreshToken, oauthRefreshTokenStoredAt: Date.now() },
		});
		const mailboxId = await landOAuthGrant(ctx, stateRow.intent, fields);
		return { mailboxId, returnTo: stateRow.returnTo };
	},
});

/** A plausible dotted hostname; anything else is not worth a DNS query. */
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * Whether Microsoft hosts the mail for this address: one of its consumer
 * domains, or a domain whose MX points at Exchange Online. The generic IMAP
 * connect form asks so it can offer Microsoft sign-in for a company address
 * whose owner did not think to pick the Outlook card.
 *
 * Resolved here rather than in the browser because the web app's CSP allows no
 * third-party DNS endpoint. Fail-soft: a lookup that fails, a malformed
 * address, or an instance without a Microsoft app all answer `false`, which only
 * means the button is not offered.
 */
// authz: authenticated member + assertExternalEnabled; answers one public DNS
// fact about a domain the caller typed, and reads no table.
export const isMicrosoftHosted = authedAction({
	args: { email: v.string() },
	handler: async (ctx, args): Promise<{ hosted: boolean }> => {
		await assertExternalEnabled(ctx);
		validateStringLength(args.email, STRING_LIMITS.EMAIL, 'Email address');
		if (!isMicrosoftOAuthConfigured()) return { hosted: false };
		const at = args.email.lastIndexOf('@');
		const domain =
			at > 0
				? args.email
						.slice(at + 1)
						.trim()
						.toLowerCase()
				: '';
		if (domain.length > 253 || !DOMAIN_PATTERN.test(domain)) return { hosted: false };
		if (isMicrosoftConsumerDomain(domain)) return { hosted: true };
		try {
			const records = await dns.resolveMx(domain);
			return { hosted: records.some((mx) => isMicrosoftMxHost(mx.exchange)) };
		} catch {
			return { hosted: false };
		}
	},
});
