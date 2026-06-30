/**
 * Copy to clipboard composable
 * Provides copy functionality with visual feedback
 */

export function useCopyToClipboard(timeout = 2000) {
	const copiedKey = ref<string | null>(null);

	const copy = async (text: string, key?: string) => {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey.value = key ?? text;

			setTimeout(() => {
				if (copiedKey.value === (key ?? text)) {
					copiedKey.value = null;
				}
			}, timeout);

			return true;
		} catch {
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
