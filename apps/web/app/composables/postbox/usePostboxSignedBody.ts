import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import {
	isTextPartSignature,
	resolveSignedBodyView,
	type SignedBodyView,
} from '~/utils/postboxSignedBody';
import { loadPostboxTextBody } from './postboxBodyResolver';

export interface SignedBodyMessage {
	_id: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
	htmlBodyStorageId?: string;
	bodyPending?: boolean;
	inboundSignatureInfo?: InboundSignatureInfo;
}

/**
 * The reader card's side of {@link resolveSignedBodyView}: it loads the text
 * body a text-part signature verdict needs when the row has none inline (a
 * body over the inline threshold), and hands the card what to render and which
 * verdict, class and body text the trust chip and security badge may use.
 *
 * Runs only while the card is expanded: a collapsed card renders no body.
 */
export function usePostboxSignedBody(source: {
	message: () => SignedBodyMessage;
	secureClass: () => SecureMessageClass;
	hideBody: () => boolean;
	active: () => boolean;
}) {
	const fetched = ref<{ text: string | null; hasHtmlBlob: boolean } | null>(null);

	const inlineText = computed(() => source.message().textBodyInline || undefined);
	const hasVerdict = computed(() => source.message().inboundSignatureInfo?.isSigned === true);

	// A text-part verdict with no inline text: the text lives in storage (or the
	// inline answer is still on its way, which needs no fetch of its own).
	const needsTextFetch = computed(
		() =>
			source.active() &&
			hasVerdict.value &&
			isTextPartSignature(source.secureClass()) &&
			!inlineText.value &&
			source.message().bodyPending !== true
	);

	let requestSequence = 0;
	watch(
		[needsTextFetch, () => source.message()._id],
		async ([shouldFetch, messageId]) => {
			const sequence = ++requestSequence;
			fetched.value = null;
			if (!shouldFetch) return;
			let result: { text: string | null; hasHtmlBlob: boolean };
			try {
				result = await loadPostboxTextBody(requireConvex(), messageId);
			} catch {
				// Unreadable is treated as no text: nothing can be shown as signed.
				result = { text: null, hasHtmlBlob: false };
			}
			if (sequence === requestSequence) fetched.value = result;
		},
		{ immediate: true }
	);

	const view = computed<SignedBodyView>(() => {
		const m = source.message();
		const text = inlineText.value ?? (m.bodyPending ? undefined : fetched.value?.text);
		return resolveSignedBodyView({
			secureClass: source.secureClass(),
			hasVerdict: hasVerdict.value,
			text,
			hasHtml: !!(m.htmlBodyInline || m.htmlBodyStorageId || fetched.value?.hasHtmlBlob),
		});
	});

	const kind = computed(() => view.value.kind);
	return {
		view,
		/** Hold the body back: it is loading, or only the signed block may show. */
		hideBody: computed(() =>
			kind.value === 'loading' || kind.value === 'signed' ? true : source.hideBody()
		),
		secureClass: computed<SecureMessageClass>(() => {
			if (kind.value === 'signed') return 'pgp-clearsigned';
			if (kind.value === 'loading') return 'none';
			return source.secureClass();
		}),
		/** The verdict stands only beside the block it describes. */
		signature: computed(() =>
			kind.value === 'loading' || kind.value === 'unbound'
				? undefined
				: source.message().inboundSignatureInfo
		),
		/** The body the security badge reads: the loaded text in the signed view. */
		badgeMessage: computed(() => {
			const m = source.message();
			return kind.value === 'signed'
				? { _id: m._id, textBodyInline: inlineText.value ?? fetched.value?.text ?? '' }
				: m;
		}),
	};
}
