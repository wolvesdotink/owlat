/**
 * The id of a mailbox's system folder (inbox, archive, ...), for the list reads
 * that accept one.
 *
 * `listMessages` and `listSections` can address a folder by role or by id. By
 * role, the server has to read the folder document to find the id, and IMAP
 * bookkeeping patches that document on every delivery and flag change, so the
 * list's first page re-runs whenever any message in the folder is marked read.
 * By id, it never reads the folder document.
 *
 * The id comes from the same `listFolders` subscription the folder rail holds
 * (identical args, so the Convex client shares it). For the virtual Snoozed
 * view, which has no folder, this is `undefined` and the caller falls back to
 * the role.
 *
 * The addressing is decided once per folder visit: by id when the folder list
 * already has the folder as the visit starts (every warm folder switch), by
 * role for the whole visit otherwise (a cold open). Switching a visit from role
 * to id when the folder list lands a moment later would subscribe page 1 a
 * second time, pay another server round trip on the path the id is meant to
 * shorten, and leave the by-role copy running in the subscription linger.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function usePostboxRoleFolderId(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	/** Skip the folder subscription while the caller does not need it. */
	enabled?: Ref<boolean>;
}) {
	const { data } = useConvexQuery(api.mail.mailbox.queries.listFolders, () =>
		args.mailboxId.value && (args.enabled?.value ?? true)
			? { mailboxId: args.mailboxId.value }
			: 'skip'
	);

	const knownId = computed<Id<'mailFolders'> | undefined>(() => {
		const mailboxId = args.mailboxId.value;
		if (!mailboxId) return undefined;
		// The mailbox check keeps a list that is still the previous mailbox's
		// from handing over a folder id the new mailbox does not own.
		return data.value?.find((f) => f.mailboxId === mailboxId && f.role === args.folderRole.value)
			?._id;
	});

	// One visit = one mailbox, one role, one enabled stretch. Synchronous, so
	// the list's args factory never sees the new folder with the old decision.
	const byId = ref(false);
	watch(
		() => `${args.enabled?.value ?? true}:${args.mailboxId.value}:${args.folderRole.value}`,
		() => {
			byId.value = knownId.value !== undefined;
		},
		{ immediate: true, flush: 'sync' }
	);

	return computed<Id<'mailFolders'> | undefined>(() => (byId.value ? knownId.value : undefined));
}
