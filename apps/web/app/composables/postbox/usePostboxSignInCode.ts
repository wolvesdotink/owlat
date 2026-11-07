/**
 * What every "use this sign-in code" entry point does with a code or link read
 * at arrival (`mail/signInCodes.ts`): the row and reader chip, the reader's
 * shortcut, the palette's "Copy latest sign-in code", and the "Copy code"
 * action of a web push or desktop notification.
 *
 * A code is copied; a link opens in the browser (the desktop shell hands a
 * `window.open` to the system browser). When the browser refuses the clipboard,
 * which it does to a page that is not focused or has no recent click (a
 * notification action lands there), the toast keeps a Copy button: a press on
 * it is the gesture the clipboard waits for.
 */
import type { Doc } from '@owlat/api/dataModel';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';

type MailSignInCode = NonNullable<Doc<'mailMessages'>['signInCode']>;

type SignInCode = Pick<MailSignInCode, 'kind' | 'value' | 'expiresAt'>;

/** The code is still offered: the server clears it at `expiresAt`, the client stops then too. */
export function isSignInCodeLive(
	code: SignInCode | null | undefined,
	now = Date.now()
): code is SignInCode {
	return !!code && now < code.expiresAt;
}

/** The newest live code among a conversation's messages (oldest first), if any. */
export function latestLiveSignInCode(
	messages: ReadonlyArray<{ signInCode?: MailSignInCode }>,
	now = Date.now()
): MailSignInCode | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const code = messages[i]?.signInCode;
		if (isSignInCodeLive(code, now)) return code;
	}
	return null;
}

export function usePostboxSignInCode() {
	const { t } = useI18n();
	const { showToast } = useToast();
	const { copy } = useCopyToClipboard();

	async function copyCode(value: string): Promise<void> {
		if (await copy(value)) {
			showToast(t('components.postbox.postboxSignInCodeChip.copied'));
			return;
		}
		showToast(t('components.postbox.postboxSignInCodeChip.copyFailed'), 'error', {
			durationMs: 0,
			action: {
				label: t('common.copy'),
				onAction: () => void copyCode(value),
			},
		});
	}

	/**
	 * Copy the code or open the link. A code that expired in the meantime (or
	 * none at all) says so instead of copying something stale.
	 */
	async function copyOrOpen(code: SignInCode | null | undefined): Promise<void> {
		if (!isSignInCodeLive(code)) {
			showToast(t('components.postbox.postboxSignInCodeChip.unavailable'), 'info');
			return;
		}
		if (code.kind === 'link') {
			window.open(code.value, '_blank', 'noopener,noreferrer');
			return;
		}
		await copyCode(code.value);
	}

	return { copyOrOpen };
}

/**
 * The "Copy code" button of a web push opens the message with
 * `?signInCode=copy` (`push/copy.ts`), because a service worker cannot write to
 * the clipboard. The reader showing that message runs the copy once and drops
 * the query, so a reload or Back never copies again.
 */
export function usePostboxSignInCodeIntent(opts: {
	messageId: () => string;
	/** Only the reader on top answers, as with the shortcuts. */
	isTopmost: () => boolean;
	run: () => void;
}): void {
	const route = useRoute();
	const router = useRouter();
	watch(
		() =>
			route.query['signInCode'] === 'copy' &&
			route.path.endsWith(`/${opts.messageId()}`) &&
			opts.isTopmost(),
		(wanted) => {
			if (!wanted) return;
			const { signInCode: _intent, ...query } = route.query;
			void router.replace({ query });
			opts.run();
		},
		{ immediate: true }
	);
}
