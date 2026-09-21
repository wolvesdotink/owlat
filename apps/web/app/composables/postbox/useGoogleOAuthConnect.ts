import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

/**
 * Start Google's authorization-code flow for an external mailbox.
 *
 * Google no longer wants password auth on IMAP/SMTP, so a Gmail mailbox is
 * connected by sending the user to Google's consent screen and letting the
 * backend exchange the returned code for a refresh token. Everything secret
 * lives on the server: this composable only asks for an authorization URL and
 * puts the browser in front of it.
 *
 * The INTENT travels with the state row, not with the callback: by the time
 * Google redirects back, all the page knows is `code` + `state`, so what the
 * exchange should DO (personal connect, credential rotation, team inbox, seed
 * mailbox) has to be recorded when the flow starts.
 */
export type GoogleConnectIntent =
	| { kind: 'connect' }
	| { kind: 'update' }
	| { kind: 'connectShared'; displayName?: string; memberUserIds: string[] }
	| { kind: 'updateShared'; mailboxId: Id<'mailboxes'> }
	| { kind: 'connectSeed'; seedProvider: DestinationProviderKey };

/**
 * The path Google's callback page sends the user back to, flagged so the wizard
 * can tell a fresh OAuth connect from an ordinary visit. Built off the CURRENT
 * route rather than a fixed page: the same form is mounted from the migrate
 * wizard, the team-inbox card and the deliverability coverage card.
 *
 * Pure (a relative path in, a relative path out) so it is unit-testable and so
 * the value can never become an absolute URL — the backend rejects a `returnTo`
 * that is not a same-site path.
 */
export function returnToWithGoogleFlag(fullPath: string): string {
	const url = new URL(fullPath, 'https://relative.invalid');
	url.searchParams.set('googleConnected', '1');
	return `${url.pathname}${url.search}${url.hash}`;
}

export function useGoogleOAuthConnect(options: { inlineTarget?: Ref<string | null> } = {}) {
	const { t } = useI18n();
	const startOp = useBackendOperation(api.mail.external.googleOAuthActions.start, {
		type: 'action',
		label: () => t('components.postbox.postboxMailboxConnectForm.google.startOperation'),
		inlineTarget: options.inlineTarget,
	});

	/**
	 * True once the consent screen has been handed to the SYSTEM browser, so the
	 * desktop app can say where the flow went. The webview stays on this page —
	 * the connected account arrives through the live `getForCurrentUser`
	 * subscription, not through a redirect back into the app.
	 */
	const handedOffToBrowser = ref(false);

	async function openAuthorizationUrl(authorizationUrl: string): Promise<void> {
		if (isDesktopRuntime()) {
			try {
				const { openExternal } = await import('@owlat/desktop/src/shell');
				await openExternal(authorizationUrl);
				handedOffToBrowser.value = true;
				return;
			} catch {
				// The shell bridge is unavailable (old shell scope, or a webview that
				// refused): navigating the webview itself is worse than nothing only
				// if it fails too, so fall through rather than dead-ending the user.
			}
		}
		window.location.assign(authorizationUrl);
	}

	/**
	 * Ask the backend for an authorization URL and send the user to it. Resolves
	 * `false` when the backend refused (the failure has already been surfaced by
	 * the operation module, inline or as a toast).
	 */
	async function connect(intent: GoogleConnectIntent, returnTo: string): Promise<boolean> {
		handedOffToBrowser.value = false;
		const res = await startOp.run({ intent, returnTo });
		if (!res.ok) return false;
		await openAuthorizationUrl(res.result.authorizationUrl);
		return true;
	}

	return { connect, isLoading: startOp.isLoading, handedOffToBrowser };
}
