/**
 * "Share as image…": one message as a card on a canvas, the words the person
 * redacts, and the three ways out (copy, save, the system share sheet).
 *
 * Everything stays in the browser. The card is drawn from the message's text
 * (utils/postboxShareCard), so no image in the mail is fetched to draw it, and
 * the PNG is handed only to the clipboard, a download or `navigator.share`.
 * The download's filename and the share call carry no text from the message:
 * the subject could be the very thing that was redacted.
 */
import { formatDateTime } from '~/utils/formatters';
import {
	buildShareCard,
	personalDetailTokenIds,
	shareCardBodyText,
} from '~/utils/postboxShareCard';
import {
	layoutShareCard,
	paintShareCard,
	shareCardTokenAt,
	type ShareCardLayout,
	type ShareCardRedactionStyle,
	type ShareCardScheme,
} from '~/utils/postboxShareCardPaint';
import { usePostboxBodySource, type PostboxBodySourceMessage } from './usePostboxBodySource';

export interface PostboxShareImageMessage extends PostboxBodySourceMessage {
	fromName?: string;
	fromAddress: string;
	subject: string;
	receivedAt: number;
}

/** Device pixels per CSS pixel: sharp on a high-density screen once shared. */
const EXPORT_SCALE = 2;
const FILENAME = 'message.png';
const FALLBACK_FONT = "Figtree, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export function usePostboxShareImage(opts: {
	message: () => PostboxShareImageMessage;
	ownName: () => string | null | undefined;
	noSubject: () => string;
	initialScheme: ShareCardScheme;
}) {
	const { waiting, effectiveHtml, effectiveText } = usePostboxBodySource(opts.message);

	const card = computed(() => {
		const message = opts.message();
		return buildShareCard({
			fromName: message.fromName,
			fromAddress: message.fromAddress,
			date: formatDateTime(message.receivedAt),
			subject: message.subject.trim() || opts.noSubject(),
			body: shareCardBodyText({ html: effectiveHtml.value, text: effectiveText.value }),
		});
	});

	const redacted = ref<ReadonlySet<number>>(new Set());
	const style = ref<ShareCardRedactionStyle>('bar');
	const scheme = ref<ShareCardScheme>(opts.initialScheme);
	// Different words (the body blob arrived) renumber the tokens, so the
	// redactions start over. A live update that leaves the words as they were
	// (the open marks the message read) keeps them.
	watch(
		() => card.value.tokens.map((token) => token.text).join('\u0000'),
		() => (redacted.value = new Set())
	);

	function toggle(tokenId: number) {
		const next = new Set(redacted.value);
		if (next.has(tokenId)) next.delete(tokenId);
		else next.add(tokenId);
		redacted.value = next;
	}
	function hidePersonalDetails() {
		redacted.value = new Set([
			...redacted.value,
			...personalDetailTokenIds(card.value, opts.ownName()),
		]);
	}
	function clearRedactions() {
		redacted.value = new Set();
	}

	// Measuring before the app's font has loaded would wrap for the fallback font.
	const fontFamily = ref<string | null>(null);
	onMounted(async () => {
		const family =
			getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() ||
			FALLBACK_FONT;
		await document.fonts?.ready;
		fontFamily.value = family;
	});

	let measureCtx: CanvasRenderingContext2D | null = null;
	const widths = new Map<string, number>();
	function measure(text: string, font: string): number {
		const key = `${font}\u0000${text}`;
		const cached = widths.get(key);
		if (cached !== undefined) return cached;
		measureCtx ??= document.createElement('canvas').getContext('2d');
		if (!measureCtx) return 0;
		measureCtx.font = font;
		const width = measureCtx.measureText(text).width;
		widths.set(key, width);
		return width;
	}

	const layout = computed<ShareCardLayout | null>(() =>
		fontFamily.value && !waiting.value
			? layoutShareCard(card.value, measure, fontFamily.value)
			: null
	);

	/** The preview is the export: the dialog shows this canvas as it will be shared. */
	const canvasEl = ref<HTMLCanvasElement | null>(null);
	watchEffect(() => {
		const canvas = canvasEl.value;
		const current = layout.value;
		if (!canvas || !current) return;
		canvas.width = current.width * EXPORT_SCALE;
		canvas.height = current.height * EXPORT_SCALE;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		paintShareCard(ctx, current, {
			redacted: redacted.value,
			style: style.value,
			scheme: scheme.value,
			scale: EXPORT_SCALE,
		});
	});

	/** The token under a click on the preview, in its displayed size. */
	function tokenAtClient(clientX: number, clientY: number): number | null {
		const canvas = canvasEl.value;
		const current = layout.value;
		if (!canvas || !current) return null;
		const rect = canvas.getBoundingClientRect();
		if (rect.width === 0) return null;
		const ratio = current.width / rect.width;
		return shareCardTokenAt(current, (clientX - rect.left) * ratio, (clientY - rect.top) * ratio);
	}

	function exportBlob(): Promise<Blob> {
		return new Promise((resolve, reject) => {
			const canvas = canvasEl.value;
			if (!canvas) return reject(new Error('share card not rendered'));
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error('empty export'))),
				'image/png'
			);
		});
	}

	const canCopy =
		import.meta.client && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
	const canShare =
		import.meta.client &&
		typeof navigator.canShare === 'function' &&
		navigator.canShare({ files: [new File([], FILENAME, { type: 'image/png' })] });

	async function copy(): Promise<void> {
		// The item takes the promise, so the write starts inside the click (Safari).
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
	}

	async function save(): Promise<void> {
		const url = URL.createObjectURL(await exportBlob());
		const a = document.createElement('a');
		a.href = url;
		a.download = FILENAME;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30000);
	}

	/** Resolves false when the person closed the share sheet without sharing. */
	async function share(): Promise<boolean> {
		const file = new File([await exportBlob()], FILENAME, { type: 'image/png' });
		try {
			await navigator.share({ files: [file] });
			return true;
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return false;
			throw error;
		}
	}

	return {
		waiting,
		card,
		layout,
		canvasEl,
		redacted,
		style,
		scheme,
		toggle,
		hidePersonalDetails,
		clearRedactions,
		tokenAtClient,
		canCopy,
		canShare,
		copy,
		save,
		share,
	};
}
