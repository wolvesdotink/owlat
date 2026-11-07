'use node';

/**
 * Sending through Microsoft Graph for a Microsoft sign-in mailbox whose tenant
 * turned SMTP AUTH off: the Graph `Mail.Send` token, and the Microsoft-only
 * fields of the worker's credential bundle.
 *
 * The scope is consented to at sign-in (`microsoftOAuthTokens.ts`), but Graph
 * is a different resource from the Exchange one the IMAP and SMTP token is
 * for, and one token request names one resource. So the stored refresh token
 * is redeemed a second time, and the token kept in its own cache slot.
 *
 * NOTHING here is logged beyond taxonomy: access and refresh tokens and the
 * client secret never reach `console.*`.
 */

import { internal } from '../../_generated/api';
import {
	GRAPH_SEND_SCOPE,
	REVOKED_ERRORS,
	microsoftTokenEndpoint,
	requireMicrosoftOAuthClient,
} from './microsoftOAuthTokens';
import { postTokenRequest, readCachedAccessToken, rememberAccessToken } from './oauthTokenShared';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';

const GRAPH_REFRESH_SCOPES = [GRAPH_SEND_SCOPE, 'offline_access'].join(' ');

/**
 * What minting a Microsoft Graph token produced. `needs_consent` means the
 * grant does not cover `Mail.Send`: a connection made before Owlat asked for
 * it, or a tenant that withheld it. Only the user signing in with Microsoft
 * again fixes that, and it says nothing about the mail grant, so the account
 * keeps syncing.
 */
export type GraphAccessTokenResult =
	| { kind: 'token'; accessToken: string; expiresAt: number }
	| { kind: 'needs_consent' }
	| { kind: 'failed' };

/**
 * Mint a Microsoft Graph access token for `Mail.Send` from the account's
 * refresh token, for sending when SMTP AUTH is off.
 *
 * Unlike `refreshMicrosoftAccessToken`, a refusal here never parks the
 * account: the IMAP and SMTP token is the one that decides whether the grant
 * is alive, and it was minted first. `invalid_grant` for this resource is how
 * Microsoft answers a refresh token that was never consented for it. The
 * refresh token the answer may carry is not stored: the mail refresh rotates
 * it, and two writers would race for the envelope.
 */
export async function refreshMicrosoftGraphAccessToken(
	ctx: ActionCtx,
	accountId: Id<'externalMailAccounts'>,
	refreshToken: string,
	envelopeIv: string
): Promise<GraphAccessTokenResult> {
	const cached = await readCachedAccessToken(ctx, accountId, envelopeIv, 'graph');
	if (cached) return { kind: 'token', ...cached };

	const client = requireMicrosoftOAuthClient();
	let token: Awaited<ReturnType<typeof postTokenRequest>>;
	try {
		token = await postTokenRequest(
			microsoftTokenEndpoint(client.tenant),
			new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: client.clientId,
				client_secret: client.clientSecret,
				scope: GRAPH_REFRESH_SCOPES,
			})
		);
	} catch {
		// A timeout or a dropped connection says nothing about the grant, and the
		// mail token the caller already holds still works for IMAP and SMTP.
		console.warn('microsoft oauth: graph token request did not get through', { accountId });
		return { kind: 'failed' };
	}
	if (token.error && REVOKED_ERRORS.has(token.error)) {
		console.warn('microsoft oauth: graph send scope not granted', {
			accountId,
			error: token.error,
		});
		return { kind: 'needs_consent' };
	}
	if (token.error || !token.access_token) {
		console.warn('microsoft oauth: graph access-token refresh failed', {
			accountId,
			error: token.error ?? 'no_access_token',
		});
		return { kind: 'failed' };
	}
	const minted = {
		accessToken: token.access_token,
		expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
	};
	await rememberAccessToken(ctx, accountId, envelopeIv, minted, 'graph');
	return { kind: 'token', ...minted };
}

/**
 * The Microsoft-only half of an oauth2 credential bundle: how the account sends,
 * and a Graph token for when Exchange Online refuses SMTP AUTH.
 *
 * Asked for on every fetch, since the worker cannot say whether it is about to
 * send, but cached for an hour like the mail token. A grant known not to cover
 * `Mail.Send` is not asked again until the user reconnects, which clears
 * `graphConsent`. Any failure here leaves the bundle without a Graph token and
 * never fails the fetch: IMAP sync does not need it.
 */
export async function microsoftSendCredentials(
	ctx: ActionCtx,
	row: Doc<'externalMailAccounts'>,
	refreshToken: string,
	envelopeIv: string
): Promise<{ sendPath: 'smtp' | 'graph'; graphAccessToken?: string }> {
	const sendPath = row.sendPath ?? 'smtp';
	if (row.graphConsent === 'missing') return { sendPath };
	const graph = await refreshMicrosoftGraphAccessToken(ctx, row._id, refreshToken, envelopeIv);
	if (graph.kind === 'failed') return { sendPath };
	const graphConsent = graph.kind === 'token' ? 'granted' : 'missing';
	if (row.graphConsent !== graphConsent) {
		await ctx.runMutation(internal.mail.external.accounts._setGraphConsentInternal, {
			accountId: row._id,
			expectedIv: envelopeIv,
			graphConsent,
		});
	}
	return graph.kind === 'token' ? { sendPath, graphAccessToken: graph.accessToken } : { sendPath };
}
