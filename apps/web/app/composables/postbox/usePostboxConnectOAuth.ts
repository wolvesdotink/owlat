import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { MailProvider } from '~/utils/mailAutodiscover';
import {
	returnToWithOAuthFlag,
	type MailOAuthIntent,
	type MailOAuthProvider,
} from '~/composables/postbox/useMailOAuthConnect';

/** The connect-form props the provider sign-in branch reads. */
interface ConnectFormOAuthProps {
	provider: MailProvider;
	mode: 'connect' | 'update';
	account?: { authMethod?: string; oauthProvider?: string } | null;
	shared?: boolean;
	displayName?: string;
	memberUserIds?: string[];
	mailboxId?: Id<'mailboxes'>;
	seedProvider?: DestinationProviderKey;
}

/**
 * The provider sign-in branch of the mailbox connect form (Google or Microsoft).
 *
 * An ADDITION to the app-password form, never a replacement for it. Sign-in
 * needs an operator to have registered an OAuth app for this instance, which
 * most self-hosters will not have done, so the password path always renders.
 * The block appears only when both halves agree: a provider applies (the picked
 * card offers one, the account being repaired already uses one, or the typed
 * address turns out to be hosted by Microsoft) and the backend says that
 * provider is configured.
 */
export function usePostboxConnectOAuth(
	props: ConnectFormOAuthProps,
	emailAddress: () => string,
	formError: Ref<string | null>
) {
	const { t } = useI18n();
	const route = useRoute();

	/** An existing OAuth account keeps its provider; a pre-column row is Google. */
	const accountProvider = computed<MailOAuthProvider | null>(() => {
		if (props.account?.authMethod !== 'oauth2') return null;
		return props.account.oauthProvider === 'microsoft' ? 'microsoft' : 'google';
	});

	// The generic IMAP card has no provider of its own. When the typed address is
	// on a Microsoft domain, or its domain's MX points at Exchange Online, offer
	// Microsoft sign-in there too: a Microsoft 365 user rarely knows to pick the
	// Outlook card for a company address. The backend resolves the MX (the CSP
	// allows the browser no DNS endpoint) and answers `false` on any doubt.
	const detectOp = useBackendOperation(api.mail.external.microsoftOAuthActions.isMicrosoftHosted, {
		type: 'action',
		label: () => t('components.postbox.postboxMailboxConnectForm.microsoft.detectOperation'),
		// A failed lookup only means the button is not offered; never a toast.
		onError: () => true,
	});
	const detectedMicrosoft = ref(false);
	let detectTimer: ReturnType<typeof setTimeout> | undefined;
	let detectSeq = 0;
	watch(emailAddress, (raw) => {
		if (detectTimer) clearTimeout(detectTimer);
		const seq = ++detectSeq;
		detectedMicrosoft.value = false;
		const email = raw.trim();
		if (!props.provider.manualServer || props.mode !== 'connect') return;
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
		detectTimer = setTimeout(() => {
			void detectOp.run({ email }).then((res) => {
				if (seq === detectSeq && res.ok) detectedMicrosoft.value = res.result.hosted;
			});
		}, 500);
	});
	onBeforeUnmount(() => {
		if (detectTimer) clearTimeout(detectTimer);
	});

	const oauthProvider = computed<MailOAuthProvider | null>(
		() =>
			accountProvider.value ??
			props.provider.oauth?.provider ??
			(detectedMicrosoft.value ? 'microsoft' : null)
	);
	const detected = computed(
		() => !accountProvider.value && !props.provider.oauth && detectedMicrosoft.value
	);

	const { data: googleOAuth } = useConvexQuery(api.mail.external.googleOAuth.isConfigured, () =>
		oauthProvider.value === 'google' ? {} : 'skip'
	);
	const { data: microsoftOAuth } = useConvexQuery(
		api.mail.external.microsoftOAuth.isConfigured,
		() => (oauthProvider.value === 'microsoft' ? {} : 'skip')
	);
	const configured = computed(() => {
		if (oauthProvider.value === 'google') return googleOAuth.value?.configured === true;
		if (oauthProvider.value === 'microsoft') return microsoftOAuth.value?.configured === true;
		return false;
	});

	const isOauthAccount = computed(() => props.account?.authMethod === 'oauth2');
	/**
	 * Re-authorizing a mailbox that already uses provider sign-in is the one case
	 * where the block leads: the account has no password to re-enter, so
	 * "Reconnect with …" is what the user came for. The password form still
	 * follows it — rotating such an account onto an app password is allowed.
	 */
	const leads = computed(() => configured.value && props.mode === 'update' && isOauthAccount.value);

	const oauth = useMailOAuthConnect({ inlineTarget: formError });

	/**
	 * The connect INTENT for this mount — the same (mode, shared, seedProvider)
	 * fan-out the form's submit dispatches on, in the form the backend stores
	 * alongside the OAuth state row. `null` means the shared update is missing
	 * its mailbox, the one branch that must refuse rather than fall through to the
	 * personal account.
	 */
	function intent(): MailOAuthIntent | null {
		if (props.mode === 'connect' && props.seedProvider) {
			return { kind: 'connectSeed', seedProvider: props.seedProvider };
		}
		if (props.mode === 'connect' && props.shared) {
			return {
				kind: 'connectShared',
				displayName: props.displayName,
				memberUserIds: props.memberUserIds ?? [],
			};
		}
		if (props.mode === 'update' && props.shared) {
			if (!props.mailboxId) return null;
			return { kind: 'updateShared', mailboxId: props.mailboxId };
		}
		return props.mode === 'update' ? { kind: 'update' } : { kind: 'connect' };
	}

	async function connect(): Promise<void> {
		const provider = oauthProvider.value;
		if (!provider) return;
		formError.value = null;
		const next = intent();
		if (!next) {
			formError.value = t('components.postbox.postboxMailboxConnectForm.missingMailboxError');
			return;
		}
		// The wizard reads the flag on the way back to start the import itself.
		await oauth.connect(provider, next, returnToWithOAuthFlag(route.fullPath));
	}

	return {
		oauthProvider,
		oauthDetected: detected,
		oauthConfigured: configured,
		oauthLeads: leads,
		isOauthAccount,
		oauthLoading: oauth.isLoading,
		oauthHandedOff: oauth.handedOffToBrowser,
		connectWithOAuth: connect,
	};
}
