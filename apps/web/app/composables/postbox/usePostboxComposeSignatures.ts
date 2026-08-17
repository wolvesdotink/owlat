/**
 * Signature selection for the composer: the mailbox's signatures, which one is
 * currently sitting in the body, and the auto-prepend of the default one on a
 * fresh compose. Split out of usePostboxCompose so that composable stays under
 * the file-size cap; the body itself stays owned by the caller and is edited
 * in place through the pure helpers in usePostboxSignatureBody.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { applySignatureToBody, wrapSignatureBlock } from './usePostboxSignatureBody';

interface ComposerSignature {
	_id: Id<'mailSignatures'>;
	name: string;
	html: string;
	isDefault: boolean;
}

export function usePostboxComposeSignatures(opts: {
	mailboxId: Id<'mailboxes'>;
	bodyHtml: Ref<string>;
	/** True when reopening a saved draft — suppresses the auto-prepend. */
	isReopenedDraft: boolean;
}) {
	// Signatures for this mailbox. The default is auto-prepended to a fresh
	// draft; the composer toolbar lets the user pick a different one per
	// message (applySignature swaps the marked block in-body).
	const signaturesQuery = useConvexQuery(api.mail.signatures.list, () => ({
		mailboxId: opts.mailboxId,
	}));
	const signatures = computed<ComposerSignature[]>(
		() => (signaturesQuery.data.value as ComposerSignature[] | undefined) ?? []
	);
	// Which signature is currently sitting in the body. `null` once the user has
	// chosen "No signature" (or before anything is applied).
	const activeSignatureId = ref<Id<'mailSignatures'> | null>(null);

	/** Swap the in-body signature block to the chosen signature (or none). */
	function applySignature(signatureId: Id<'mailSignatures'> | null) {
		const sig = signatureId ? signatures.value.find((s) => s._id === signatureId) : null;
		opts.bodyHtml.value = applySignatureToBody(opts.bodyHtml.value, sig?.html ?? '');
		activeSignatureId.value = sig?._id ?? null;
	}

	// Auto-prepend the default signature to a fresh, empty draft.
	// A reopened draft already carries its own signature in the saved body;
	// auto-prepending here would race drafts.get hydration — if this watcher wins
	// it writes the signature into the still-empty body, hydration's
	// `if (!bodyHtml.value)` guard then skips loading the saved body, and autosave
	// later persists the signature OVER the saved draft (silent data loss). So we
	// only auto-prepend for a brand-new compose, never when reopening a draft.
	let signaturePrepended = opts.isReopenedDraft;
	watch(
		() => signatures.value,
		(sigs) => {
			if (signaturePrepended) return;
			if (sigs.length === 0) return;
			signaturePrepended = true;
			const def = sigs.find((s) => s.isDefault);
			if (!def) return;
			// Only prepend if the body is still empty / unedited.
			if (opts.bodyHtml.value.trim().length > 0) return;
			opts.bodyHtml.value = `${wrapSignatureBlock(def.html)}`;
			activeSignatureId.value = def._id;
		},
		{ immediate: true }
	);

	return { signatures, activeSignatureId, applySignature };
}
