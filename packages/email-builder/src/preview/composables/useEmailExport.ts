import { ref } from 'vue';

/**
 * The previewer's export actions. `copiedFormat` names the format copied last
 * for two seconds, so a reopened menu can confirm it; `onDone` runs after each
 * action (it closes the menu).
 */
export function useEmailExport(onDone: () => void) {
	const copiedFormat = ref<string | null>(null);

	async function copyToClipboard(text: string, format: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedFormat.value = format;
			setTimeout(() => {
				copiedFormat.value = null;
			}, 2000);
		} catch {
			// Fallback for older browsers
			const textarea = document.createElement('textarea');
			textarea.value = text;
			textarea.style.position = 'fixed';
			textarea.style.opacity = '0';
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand('copy');
			document.body.removeChild(textarea);
			copiedFormat.value = format;
			setTimeout(() => {
				copiedFormat.value = null;
			}, 2000);
		}
		onDone();
	}

	function downloadFile(content: string, filename: string, mimeType: string) {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		onDone();
	}

	return { copiedFormat, copyToClipboard, downloadFile };
}
