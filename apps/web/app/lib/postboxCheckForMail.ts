/**
 * "Check for mail": asks the mail-sync worker to sync the caller's connected
 * accounts now (`mail.external.checkForMail.request`). The desktop tray item
 * (plugins/1.desktop-menu.client.ts) and the command palette verb share it.
 *
 * Mail to a hosted address is pushed in as it arrives, so the answer for
 * someone with no connected account says there is nothing to check rather
 * than pretending to check.
 */
import { api } from '@owlat/api';
import type { ConvexClient } from 'convex/browser';

export type CheckForMailOutcome = 'checking' | 'nothing' | 'busy' | 'failed';

/** The toast each outcome shows. */
export const CHECK_FOR_MAIL_MESSAGE_KEYS: Record<CheckForMailOutcome, string> = {
	checking: 'postbox.checkForMail.checking',
	nothing: 'postbox.checkForMail.nothing',
	busy: 'postbox.checkForMail.busy',
	failed: 'postbox.checkForMail.failed',
};

export async function requestMailCheck(client: ConvexClient | null): Promise<CheckForMailOutcome> {
	if (!client) return 'failed';
	try {
		const result = await client.mutation(api.mail.external.checkForMail.request, {});
		if (result.accounts === 0) return 'nothing';
		return result.throttled ? 'busy' : 'checking';
	} catch {
		return 'failed';
	}
}

interface CheckForMailDeps {
	client: ConvexClient | null;
	t: (key: string) => string;
	showToast: (message: string, type: 'success' | 'error' | 'info') => unknown;
}

/** Ask for the check and say how it went. */
export async function checkForMail(deps: CheckForMailDeps): Promise<CheckForMailOutcome> {
	const outcome = await requestMailCheck(deps.client);
	deps.showToast(t(deps, outcome), outcome === 'failed' ? 'error' : 'info');
	return outcome;
}

function t(deps: CheckForMailDeps, outcome: CheckForMailOutcome): string {
	return deps.t(CHECK_FOR_MAIL_MESSAGE_KEYS[outcome]);
}
