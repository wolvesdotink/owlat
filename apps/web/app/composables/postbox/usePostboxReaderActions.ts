import type { ComputedRef, Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { BackendOperationResult } from '~/composables/useBackendOperation';
import { pickAdjacentMessageId, type PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import type { PostboxSnoozeScope } from '~/utils/postboxSnoozeScope';

/** The live thread fields the reader's thread-level actions branch on. */
export type ReaderActionThread = {
	_id: string;
	mutedAt?: number;
	notifyOnReplyAt?: number;
};

/** The open message as the actions see it: id plus the text the snooze hint reads. */
type ReaderActionMessage = {
	_id: string;
	subject: string;
	snippet?: string;
	flagSeen?: boolean;
};

type MovedRows = {
	moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }>;
} | null;

/**
 * Thread-level triage of the OPEN message — archive / trash / star / read /
 * snooze / mute / alert / label / move / spam / block — plus the auto-advance
 * that follows a triage and the pickers it opens. Extracted from
 * PostboxThreadReader.vue so the reader shell and its verbs stay independently
 * readable; behaviour is unchanged.
 *
 * `runReaderAction` is the single entry point shared by the keyboard
 * shortcuts, the palette-command bridge and the reader toolbar, so a demoted
 * action stays reachable from every surface. Reply / reply-all / forward are
 * routed back through `compose`, because the reader owns the sender-auth reply
 * guard those go through.
 *
 * `advance` describes the host: the list's current visual order and folder
 * (folder view only — the search preview passes neither and stays put), and
 * whether the host swaps the reader in place (the Today overlay) instead of
 * navigating to the folder route.
 */
export function usePostboxReaderActions(opts: {
	getMessage: () => ReaderActionMessage;
	messageId: ComputedRef<Id<'mailMessages'>>;
	mailboxId: ComputedRef<Id<'mailboxes'>>;
	allMessages: ComputedRef<ReadonlyArray<{ _id: string }>>;
	readerThread: ComputedRef<ReaderActionThread | null | undefined>;
	autoAdvance: Ref<PostboxAutoAdvanceMode> | ComputedRef<PostboxAutoAdvanceMode>;
	advance: {
		ids: () => string[] | undefined;
		folderRole: () => string | undefined;
		inPlace: () => boolean | undefined;
		emit: (messageId: string | null) => void;
	};
	compose: {
		reply: () => void;
		replyAll: () => void;
		forward: () => void;
	};
}) {
	const { getMessage, messageId, mailboxId, allMessages, readerThread, autoAdvance, advance } =
		opts;
	const { t } = useI18n();

	const bulk = usePostboxBulkActions(mailboxId);
	const { labels, setOnMessage: setLabelOnMessage } = usePostboxLabels(mailboxId);
	const { folders } = usePostboxFolders(mailboxId);
	const movableFolders = computed(() =>
		folders.value.filter((f) => f.role !== 'sent' && f.role !== 'drafts')
	);

	const archiveOp = useBackendOperation(api.mail.messageActions.archive, {
		label: () => t('common.archive'),
	});
	const trashOp = useBackendOperation(api.mail.messageActions.trash, {
		label: () => t('components.postbox.postboxThreadReader.moveToTrashOperation'),
	});
	const setStarOp = useBackendOperation(api.mail.messageActions.setStar, {
		label: () => t('components.postbox.postboxThreadReader.star'),
	});
	const markReadOp = useBackendOperation(api.mail.messageActions.markRead, {
		label: () => t('components.postbox.postboxThreadReader.markReadOperation'),
	});
	const snoozeOp = useBackendOperation(api.mail.snooze.snooze, {
		label: () => t('components.postbox.postboxThreadReader.snoozeOperation'),
	});
	const snoozeUntilReplyOp = useBackendOperation(api.mail.snooze.snoozeUntilReply, {
		label: () => t('components.postbox.postboxThreadReader.snoozeUntilReplyOperation'),
	});
	const snoozeThreadOp = useBackendOperation(api.mail.snooze.snoozeThread, {
		label: () => t('components.postbox.postboxThreadReader.snoozeOperation'),
	});
	const setMutedOp = useBackendOperation(api.mail.mute.setMutedForMessage, {
		label: () => t('components.postbox.postboxThreadReader.muteOperation'),
	});
	const setNotifyOnReplyOp = useBackendOperation(api.mail.threadAlerts.setNotifyOnReplyForMessage, {
		label: () => t('components.postbox.postboxThreadReader.notifyOnReplyOperation'),
	});
	const moveOp = useBackendOperation(api.mail.messageActions.move, {
		label: () => t('components.postbox.postboxThreadReader.moveOperation'),
	});
	const reportSpamOp = useBackendOperation(api.mail.messageActions.reportSpam, {
		label: () => t('components.postbox.postboxThreadReader.reportSpam'),
	});
	const notSpamOp = useBackendOperation(api.mail.messageActions.notSpam, {
		label: () => t('components.postbox.postboxThreadReader.notSpamOperation'),
	});
	const blockSenderOp = useBackendOperation(api.mail.messageActions.blockSender, {
		label: () => t('components.postbox.postboxThreadReader.blockSender'),
	});

	// Successful triage registers its inverse for the "Undo — Cmd+Z" toast
	// (the move-family mutations return each message's source folder).
	const triageUndo = usePostboxTriageUndo();
	function registerTriageUndo(
		label: string,
		outcome: BackendOperationResult<MovedRows>,
		before?: () => Promise<unknown>
	) {
		if (!outcome.ok || !outcome.result || outcome.result.moved.length === 0) return;
		triageUndo.registerMoveBack({
			label,
			moved: outcome.result.moved,
			runMove: (a) => moveOp.run(a),
			...(before ? { before } : {}),
		});
	}

	async function runAndAdvance(run: () => Promise<BackendOperationResult<unknown>>) {
		// Capture the target before the mutation — the live list drops the
		// triaged row once the server confirms, shifting the indices.
		const folderRole = advance.folderRole();
		const target = folderRole
			? pickAdjacentMessageId(advance.ids() ?? [], getMessage()._id, autoAdvance.value)
			: null;
		const outcome = await run();
		// Stay put only on THROWN errors — useBackendOperation's catch path maps
		// those to `ok: false`. Anything the server returns (incl. a handler
		// `return undefined`, which Convex serializes to `null` on the client —
		// e.g. archive/trash's row-already-gone soft-fail, or snooze's void
		// success) still advances; that's fine because the row is gone either way.
		if (!outcome.ok) return;
		// Overlay host: swap the reader in place (or close it at the list's ends)
		// instead of leaving the Today surface for the three-pane route.
		if (advance.inPlace()) {
			advance.emit(target);
			return;
		}
		if (!folderRole) return;
		void navigateTo(
			target ? `/dashboard/postbox/${folderRole}/${target}` : `/dashboard/postbox/${folderRole}`
		);
	}

	// Live flags of the open message (the prop can be a stale list row).
	const openMessageFlags = computed(() => {
		const message = getMessage();
		const live = allMessages.value.find((m) => m._id === message._id) as
			| { flagSeen?: boolean; flagFlagged?: boolean }
			| undefined;
		return {
			seen: live?.flagSeen ?? message.flagSeen ?? true,
			flagged: live?.flagFlagged ?? false,
		};
	});

	const snoozeDialogOpen = ref(false);
	const labelDialogOpen = ref(false);
	const moveDialogOpen = ref(false);

	function snoozeOpenMessage(until: number, scope: PostboxSnoozeScope) {
		const threadId = readerThread.value?._id;
		// Thread scope is the dialog's default; a reader opened on a row whose thread
		// hasn't loaded yet falls back to deferring just this message.
		if (scope === 'thread' && threadId) {
			void runAndAdvance(() =>
				snoozeThreadOp.run({ threadId: threadId as Id<'mailThreads'>, until })
			);
			return;
		}
		void runAndAdvance(() => snoozeOp.run({ messageId: messageId.value, until }));
	}

	/**
	 * Mute/unmute the open conversation. Muting archives the thread's inbox mail
	 * server-side, so it triages the reader away exactly like archive does;
	 * unmuting only drops the marker and keeps the thread open.
	 */
	const isThreadMuted = computed(() => readerThread.value?.mutedAt != null);
	function toggleOpenThreadMute() {
		const muted = !isThreadMuted.value;
		if (muted) {
			void runAndAdvance(() => setMutedOp.run({ messageId: messageId.value, muted: true }));
			return;
		}
		void setMutedOp.run({ messageId: messageId.value, muted: false });
	}

	/**
	 * Arm/disarm "notify me when they reply" on the open conversation. Purely a
	 * notification preference — unlike mute it moves no mail, so the reader stays
	 * exactly where it is. The server keeps it mutually exclusive with mute.
	 */
	const isThreadAlerted = computed(() => readerThread.value?.notifyOnReplyAt != null);
	function toggleOpenThreadAlert() {
		void setNotifyOnReplyOp.run({
			messageId: messageId.value,
			enabled: !isThreadAlerted.value,
		});
	}

	function snoozeOpenMessageUntilReply(capUntil: number) {
		void runAndAdvance(() => snoozeUntilReplyOp.run({ messageId: messageId.value, capUntil }));
	}

	// Subject + snippet feed the deterministic wake-time suggestion in the dialog.
	const snoozeHintText = computed(() => {
		const message = getMessage();
		return [message.subject, message.snippet].filter(Boolean).join(' ');
	});

	async function applyLabelToOpenMessage(labelId: Id<'mailLabels'>) {
		labelDialogOpen.value = false;
		await setLabelOnMessage(messageId.value, labelId, true);
	}

	async function moveOpenMessageTo(targetFolderId: Id<'mailFolders'>) {
		moveDialogOpen.value = false;
		const result = await moveOp.run({ messageIds: [messageId.value], targetFolderId });
		registerTriageUndo(t('components.postbox.postboxThreadReader.undoMoved'), result);
	}

	function reportSpamMessage(msgId: string) {
		const messageIds = [msgId as Id<'mailMessages'>];
		const run = async () => {
			const result = await reportSpamOp.run({ messageIds });
			// Undo = notSpam (clears the verdict, parks in Inbox) + move back to
			// the true source folder when it wasn't the Inbox.
			registerTriageUndo(t('components.postbox.postboxThreadReader.undoSpam'), result, () =>
				notSpamOp.run({ messageIds })
			);
			return result;
		};
		// Only the OPEN message's spam report ejects the reader; reporting an
		// older message inside the thread keeps the conversation open.
		if (msgId === getMessage()._id) void runAndAdvance(run);
		else void run();
	}

	function blockSenderOf(msgId: string) {
		void blockSenderOp.run({ messageId: msgId as Id<'mailMessages'> });
	}

	/** Live starred state of a specific message in the thread. */
	function isMessageStarred(msg: { _id: string; flagFlagged?: boolean }): boolean {
		const live = allMessages.value.find((m) => m._id === msg._id) as
			| { flagFlagged?: boolean }
			| undefined;
		return live?.flagFlagged ?? msg.flagFlagged ?? false;
	}

	/** Toggle the star on a specific message (per-row affordance). */
	function toggleMessageStar(msg: { _id: string; flagFlagged?: boolean }) {
		void setStarOp.run({
			messageId: msg._id as Id<'mailMessages'>,
			starred: !isMessageStarred(msg),
		});
	}

	/**
	 * Run a thread-level action against the OPEN message. Shared by the keyboard
	 * shortcuts, the palette-command bridge, and the reader toolbar so a demoted
	 * action stays reachable from every entry point (keyboard, Cmd-K, overflow).
	 */
	function runReaderAction(action: string) {
		switch (action) {
			case 'archive':
				void runAndAdvance(async () => {
					const result = await archiveOp.run({ messageIds: [messageId.value] });
					registerTriageUndo(t('components.postbox.postboxThreadReader.undoArchived'), result);
					return result;
				});
				break;
			case 'trash':
				void runAndAdvance(async () => {
					const result = await trashOp.run({ messageIds: [messageId.value] });
					registerTriageUndo(t('components.postbox.postboxThreadReader.undoTrashed'), result);
					return result;
				});
				break;
			case 'star':
				void setStarOp.run({
					messageId: messageId.value,
					starred: !openMessageFlags.value.flagged,
				});
				break;
			case 'toggleRead':
				void markReadOp.run({ messageId: messageId.value, seen: !openMessageFlags.value.seen });
				break;
			case 'markUnread':
				void markReadOp.run({ messageId: messageId.value, seen: false });
				break;
			case 'toggleSelect':
				bulk.toggle(messageId.value);
				break;
			case 'reply':
				opts.compose.reply();
				break;
			case 'replyAll':
				opts.compose.replyAll();
				break;
			case 'forward':
				opts.compose.forward();
				break;
			case 'snooze':
				snoozeDialogOpen.value = true;
				break;
			case 'mute':
				toggleOpenThreadMute();
				break;
			case 'label':
				labelDialogOpen.value = true;
				break;
			case 'move':
				moveDialogOpen.value = true;
				break;
			case 'reportSpam':
				reportSpamMessage(getMessage()._id);
				break;
			case 'blockSender':
				blockSenderOf(getMessage()._id);
				break;
			case 'print':
				if (import.meta.client) window.print();
				break;
		}
	}

	return {
		labels,
		movableFolders,
		snoozeDialogOpen,
		labelDialogOpen,
		moveDialogOpen,
		snoozeHintText,
		isMessageStarred,
		toggleMessageStar,
		toggleOpenThreadMute,
		toggleOpenThreadAlert,
		snoozeOpenMessage,
		snoozeOpenMessageUntilReply,
		applyLabelToOpenMessage,
		moveOpenMessageTo,
		reportSpamMessage,
		blockSenderOf,
		runReaderAction,
	};
}
