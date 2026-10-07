import type { SecureMessageClass } from '@owlat/shared/secureMessage';
import type { InboundSignatureInfo } from '~/utils/signatureBadge';
import {
	resolveSignedBodyView,
	signedBodyScopeOf,
	type SignedBodyText,
	type SignedBodyView,
} from '~/utils/postboxSignedBody';
import { loadPostboxTextBody } from './postboxBodyResolver';

export interface SignedBodyMessage {
	_id: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
	htmlBodyStorageId?: string;
	bodyPending?: boolean;
	attachments?: readonly unknown[];
	inboundSignatureInfo?: InboundSignatureInfo;
}

/** A settled load of the stored text body. */
type FetchedText =
	| { state: 'failed' }
	| { state: 'loaded'; text: string | null; hasHtmlBlob: boolean };

/**
 * The reader card's side of {@link resolveSignedBodyView}: it loads the text
 * body a signature verdict needs when the row has none inline (a body over the
 * inline threshold), and hands the card what to render and which verdict,
 * class and body text the trust chip and security badge may use.
 *
 * Runs only while the card is expanded: a collapsed card renders no body.
 */
export function usePostboxSignedBody(source: {
	message: () => SignedBodyMessage;
	secureClass: () => SecureMessageClass;
	hideBody: () => boolean;
	active: () => boolean;
}) {
	// The stored text body once its load settled: a failed load is not "no text".
	const fetched = ref<FetchedText | null>(null);

	const inlineText = computed(() => source.message().textBodyInline || undefined);
	const scope = computed(() => signedBodyScopeOf(source.message().inboundSignatureInfo));
	// Anything beside the text part: an HTML alternative, or any attachment (an
	// invite among them), which the signed view leaves out or only lists.
	const hasOtherParts = computed(() => {
		const m = source.message();
		const blob = fetched.value?.state === 'loaded' && fetched.value.hasHtmlBlob;
		return !!(m.htmlBodyInline || m.htmlBodyStorageId || blob || m.attachments?.length);
	});

	// The verdict needs the text and none is inline: it lives in storage (or the
	// inline answer is still on its way, which needs no fetch of its own).
	const needsTextFetch = computed(
		() =>
			source.active() &&
			!inlineText.value &&
			source.message().bodyPending !== true &&
			resolveSignedBodyView({
				secureClass: source.secureClass(),
				scope: scope.value,
				text: { state: 'loading' },
				hasOtherParts: false,
			}).kind === 'loading'
	);

	let requestSequence = 0;
	watch(
		[needsTextFetch, () => source.message()._id],
		async ([shouldFetch, messageId]) => {
			const sequence = ++requestSequence;
			fetched.value = null;
			if (!shouldFetch) return;
			let result: FetchedText;
			try {
				result = { state: 'loaded', ...(await loadPostboxTextBody(requireConvex(), messageId)) };
			} catch {
				result = { state: 'failed' };
			}
			if (sequence === requestSequence) fetched.value = result;
		},
		{ immediate: true }
	);

	const text = computed<SignedBodyText>(() => {
		if (inlineText.value) return { state: 'loaded', text: inlineText.value };
		const settled = fetched.value;
		if (source.message().bodyPending || !settled) return { state: 'loading' };
		return settled.state === 'failed' ? settled : { state: 'loaded', text: settled.text };
	});

	const view = computed<SignedBodyView>(() =>
		resolveSignedBodyView({
			secureClass: source.secureClass(),
			scope: scope.value,
			text: text.value,
			hasOtherParts: hasOtherParts.value,
		})
	);

	const kind = computed(() => view.value.kind);
	return {
		view,
		/**
		 * The one gate for everything the card derives from the message body.
		 * While true, the signed block is the only body content rendered: no
		 * other part, no card built from one (an invite, a scheduling chip), no
		 * preview of an attachment and no snippet. Attachments stay listed for
		 * download and count toward the omission note. A new body-derived surface
		 * on the card must read this gate.
		 */
		signedOnly: computed(() => kind.value === 'signed' || kind.value === 'loading'),
		/** Hold the body back: it is loading, or only the signed block may show. */
		hideBody: computed(() =>
			kind.value === 'loading' || kind.value === 'signed' ? true : source.hideBody()
		),
		secureClass: computed<SecureMessageClass>(() => {
			if (kind.value === 'signed') return 'pgp-clearsigned';
			if (kind.value === 'loading') return 'none';
			return source.secureClass();
		}),
		/**
		 * Withheld while the text loads, when nothing shown can be tied to it, and
		 * always when it has no scope (see `utils/postboxSignedBody.ts`).
		 */
		signature: computed(() =>
			scope.value === null || kind.value === 'loading' || kind.value === 'withheld'
				? undefined
				: source.message().inboundSignatureInfo
		),
		/** The body the security badge reads: the loaded text in the signed view. */
		badgeMessage: computed(() => {
			const m = source.message();
			return kind.value === 'signed'
				? {
						_id: m._id,
						textBodyInline: text.value.state === 'loaded' ? (text.value.text ?? '') : '',
					}
				: m;
		}),
	};
}
