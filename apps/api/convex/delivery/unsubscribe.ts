'use node';

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { makeContactToken, verifyContactToken } from './contactToken';

// Unsubscribe tokens use the shared contact-token codec with an empty namespace
// prefix. Format: {contactId}:{timestamp}:{signature}, signed with UNSUBSCRIBE_SECRET.
export function generateUnsubscribeToken(contactId: string): string {
	return makeContactToken('', contactId);
}

// Internal action to validate unsubscribe token (called by httpAction handlers)
export const validateToken = internalAction({
	args: { token: v.string() },
	handler: async (_ctx, args) => {
		return verifyContactToken('', args.token);
	},
});

// Generate the full unsubscribe URL
export function getUnsubscribeUrl(siteUrl: string, contactId: string): string {
	const token = generateUnsubscribeToken(contactId);
	return `${siteUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
}

// Generate List-Unsubscribe header value (RFC 8058 one-click unsubscribe)
export function getListUnsubscribeHeader(
	convexSiteUrl: string,
	contactId: string
): { listUnsubscribe: string; listUnsubscribePost: string } {
	const token = generateUnsubscribeToken(contactId);
	const unsubscribeUrl = `${convexSiteUrl}/unsub/${encodeURIComponent(token)}`;
	return {
		// List-Unsubscribe header — HTTPS one-click endpoint (mailto form intentionally omitted)
		listUnsubscribe: `<${unsubscribeUrl}>`,
		// List-Unsubscribe-Post header for one-click unsubscribe (RFC 8058)
		listUnsubscribePost: 'List-Unsubscribe=One-Click',
	};
}
