/**
 * The composer's draft fields as they leave the editor: one snapshot, three
 * consumers.
 *
 *  - Autosave (`usePostboxComposeAutosave`) spreads it into `drafts.update` and
 *    adds `followUpRemindAt`.
 *  - The on-device mirror (`usePostboxComposeMirror`) stores exactly this. It
 *    deliberately leaves `followUpRemindAt` out: the mirror is for what a
 *    person types, and a lost reminder costs one click to set again, while
 *    carrying it would add a field to every restore comparison.
 *  - The offline send (`usePostboxComposeOfflineSend`) spreads it into the
 *    queued payload and adds the references a replay needs: mailbox, draft,
 *    reply target, From, reminder, attachments and the send options.
 *
 * The mirror's restore offer compares its stored snapshot with the fields the
 * server row hydrated, so a serialisation that differed between autosave and
 * the mirror would make every draft look changed. Keeping the rule here (most
 * of all: `bodyBlocks` only in 'full' mode) is what keeps them equal.
 *
 * Module scope: no Vue and no composable imports. The sources are anything
 * with a `.value`, which the composer's refs are.
 */

/** A readable ref: the only part of Vue's `Ref` this module relies on. */
type Source<T> = { readonly value: T };

/** Composer editing mode; spelled out so this module stays a leaf. */
export type DraftComposerMode = 'simple' | 'full';

/** The canonical draft fields: everything a person types into the composer. */
export interface DraftFields {
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	/** Serialized EditorBlock[]; only ever present in 'full' composer mode. */
	bodyBlocks?: string;
	composerMode: DraftComposerMode;
}

/** The live composer refs the snapshot reads. */
export interface DraftFieldSources {
	toAddresses: Source<string[]>;
	ccAddresses: Source<string[]>;
	bccAddresses: Source<string[]>;
	subject: Source<string>;
	bodyHtml: Source<string>;
	/** EditorBlock[]; typed loosely so this leaf needs no email-builder import. */
	bodyBlocks: Source<readonly unknown[]>;
	composerMode: Source<DraftComposerMode>;
}

/**
 * Snapshot the draft fields. Recipient lists are copied, so a later edit in
 * the composer cannot reach into a stored or queued snapshot.
 */
export function composeDraftFields(sources: DraftFieldSources): DraftFields {
	const composerMode = sources.composerMode.value;
	return {
		toAddresses: [...sources.toAddresses.value],
		ccAddresses: [...sources.ccAddresses.value],
		bccAddresses: [...sources.bccAddresses.value],
		subject: sources.subject.value,
		bodyHtml: sources.bodyHtml.value,
		// Only in 'full' mode: keeps simple-mode drafts small and unambiguous on
		// the wire, and a simple-mode snapshot never carries blocks the server
		// row does not have.
		bodyBlocks: composerMode === 'full' ? JSON.stringify(sources.bodyBlocks.value) : undefined,
		composerMode,
	};
}
