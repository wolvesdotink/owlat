'use node';

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { makeContactToken, verifyContactToken } from './contactToken';

// Preference-center tokens use the shared contact-token codec with the 'pref:'
// namespace prefix so they can't be replayed as unsubscribe tokens (same secret,
// different signed payload). Format: {contactId}:{timestamp}:{signature}.
export function generatePreferenceToken(contactId: string): string {
	return makeContactToken('pref:', contactId);
}

// Internal action to validate preference token (called by httpAction handlers)
export const validateToken = internalAction({
	args: { token: v.string() },
	handler: async (_ctx, args) => {
		return verifyContactToken('pref:', args.token);
	},
});

// Generate the full preference center URL
export function getPreferenceUrl(siteUrl: string, contactId: string): string {
	const token = generatePreferenceToken(contactId);
	return `${siteUrl}/preferences?token=${encodeURIComponent(token)}`;
}
