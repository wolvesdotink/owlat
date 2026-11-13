import { useToast } from '@owlat/ui/composables/useToast';
import { useAnnounce } from '~/composables/useAnnounce';

export interface CopyToClipboardOptions {
	/** How long, in milliseconds, `isCopied` stays true after a copy. */
	timeout?: number;
	/**
	 * Tell the person how the copy went: announce "Copied" to a screen reader
	 * (the visual swap to a tick is silent) and toast a failure. A failed copy is
	 * common on a plain-http self-host, where `navigator.clipboard` does not
	 * exist, and returning `false` alone leaves the button looking as if it did
	 * nothing. A caller that words its own success or failure toast turns this
	 * off, so the person is not told twice.
	 */
	notify?: boolean;
}

/**
 * Copy to clipboard composable
 * Provides copy functionality with visual feedback
 */
export function useCopyToClipboard({ timeout = 2000, notify = true }: CopyToClipboardOptions = {}) {
	const copiedKey = ref<string | null>(null);
	const { t } = useI18n();
	const { showToast } = useToast();
	const { announce } = useAnnounce();

	const copy = async (text: string, key?: string) => {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey.value = key ?? text;
			if (notify) announce(t('common.copied'));

			setTimeout(() => {
				if (copiedKey.value === (key ?? text)) {
					copiedKey.value = null;
				}
			}, timeout);

			return true;
		} catch {
			if (notify) showToast(t('common.copyFailed'), 'error');
			return false;
		}
	};

	const isCopied = (key: string): boolean => {
		return copiedKey.value === key;
	};

	const reset = () => {
		copiedKey.value = null;
	};

	return {
		copiedKey: readonly(copiedKey),
		copy,
		isCopied,
		reset,
	};
}
