/**
 * The types around the device mirror composable (`usePostboxComposeMirror`):
 * what the composer hands it, what Restore writes, and what a Restore attempt
 * ends in. Split out for the file-size ratchet.
 */

import type { Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from './usePostboxCompose';
import type { LatestDraftRow } from './usePostboxComposeHydration';
import type { ComposeTouched } from './usePostboxComposeTouched';

export type { MirrorOffer } from '~/utils/postboxDraftMirrorScan';

/** The wire snapshot autosave sends, plus the restored blocks. */
export type RestoredWrite = {
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	bodyBlocks: string;
	composerMode: ComposerMode;
	followUpRemindAt: number | null;
};

export interface ComposeMirrorSources {
	mailboxId: Id<'mailboxes'>;
	draftId: Ref<Id<'mailDrafts'> | null>;
	/** The message a reply answers (a fresh reply only offers its own copies). */
	inReplyToMessageId?: Id<'mailMessages'>;
	/** The composer holds the loaded row (or has none to load). */
	ready: Readonly<Ref<boolean>>;
	/** Writes pause while the row is read-only (scheduled / pending send). */
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	/** The composer's latest knowledge of its row. */
	latestRow: Readonly<Ref<LatestDraftRow>>;
	touched: ComposeTouched;
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	composerMode: Ref<ComposerMode>;
	followUpRemindAt: Ref<number | null>;
	/** Autosave's queue and row, which Restore writes through. */
	autosave: {
		ensureDraft: () => Promise<Id<'mailDrafts'> | null>;
		pause: () => void;
		resume: () => void;
		drain: () => Promise<void>;
		persistRestored: (snapshot: RestoredWrite) => Promise<{ ok: boolean }>;
		onCreated: (listener: (id: Id<'mailDrafts'>) => void) => () => void;
	};
}

/** What a Restore attempt ended in, for the bar to act on. */
export type RestoreOutcome =
	| { status: 'restored' }
	| { status: 'needs-confirmation' }
	| { status: 'aborted'; reason: 'backup-failed' | 'unavailable' | 'busy' };
