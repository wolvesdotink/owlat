import { shallowRef } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PaletteArgumentOption } from '~/lib/commandPalette';
import {
	POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX,
	POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
	type ThreadFollowUpState,
	buildThreadSurfaceGroups,
} from '~/lib/commandPaletteThreadSurfaces';
import { matchPostboxRoute } from '~/composables/postbox/usePostboxCommandSurface';
import { postboxFolderLabel } from '~/composables/postbox/usePostboxFolderName';
import { usePostboxFollowUp } from '~/composables/postbox/usePostboxFollowUp';
import { usePostboxOriginalEml } from '~/composables/postbox/usePostboxOriginalEml';
import { usePostboxSnoozePresets } from '~/composables/postbox/usePostboxSnoozePresets';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';
import { followUpPresets } from '~/utils/postboxFollowUpPresets';

/** What the open conversation hands the palette. */
export interface PostboxThreadCommandSources {
	/** Subject of the open message, for the rows' muted context line. */
	subject: () => string;
	/** The open message (the route's id) and its thread, once loaded. */
	messageId: () => string;
	threadId: () => string | undefined;
	mailboxId: () => string;
	/** The route that opens this conversation (for "Copy link" and Jump back). */
	href: () => string;
	/** Subject + snippet, for the snooze presets' suggestion. */
	hintText: () => string;
	isMuted: () => boolean;
	isAlerted: () => boolean;
	/** The follow-up watch: armable on the sent message `outboundId`, armed, or neither. */
	followUp: () => { state: ThreadFollowUpState; outboundId?: string };
	canTranslate: () => boolean;
	labels: () => ReadonlyArray<{ _id: string; name: string }>;
	folders: () => ReadonlyArray<{ _id: string; name: string; role?: string | null }>;
	/** The reader's single action entry point (keys, toolbar and palette alike). */
	runAction: (action: string) => void;
	snooze: (until: number) => void;
	snoozeUntilReply: (capUntil: number) => void;
	applyLabel: (labelId: Id<'mailLabels'>) => void;
	moveTo: (folderId: Id<'mailFolders'>) => void;
	toggleMute: () => void;
	toggleAlert: () => void;
	translate: () => void;
}

/**
 * The mounted readers, oldest first. Two can be up at once (the folder reader
 * under the Today overlay); the one mounted last is the one on top, and the
 * only one that answers the palette — a verb must act on the conversation the
 * person is looking at, never on the one underneath.
 */
const mountedReaders = shallowRef<readonly string[]>([]);

/**
 * Registers the OPEN CONVERSATION as a palette provider for as long as the
 * reader is mounted, and records it for the palette's "Jump back" list.
 *
 * Every verb the reader offers is here — reply, archive, snooze ›, forward,
 * mark unread, mute, notify on reply, label ›, move ›, remind me if no reply ›,
 * translate, the original `.eml`, copy link — and each runs THIS reader's own
 * action rather than a window-event broadcast to every mounted reader.
 */
export function usePostboxThreadCommandSurface(sources: PostboxThreadCommandSources): void {
	const { t } = useI18n();
	const instanceId = useId();
	const { showToast } = useToast();
	const followUp = usePostboxFollowUp();
	const original = usePostboxOriginalEml();
	const { snoozeOptions } = usePostboxSnoozePresets();
	const { copy } = useCopyToClipboard();

	onMounted(() => {
		mountedReaders.value = [...mountedReaders.value, instanceId];
	});
	onBeforeUnmount(() => {
		mountedReaders.value = mountedReaders.value.filter((id) => id !== instanceId);
	});

	useRecordPaletteObjectOpen(() => {
		const messageId = sources.messageId();
		return {
			kind: 'conversation',
			id: sources.threadId() ?? messageId,
			messageId,
			mailboxId: sources.mailboxId(),
			title: sources.subject().trim() || t('components.appCommandPalette.noSubject'),
			href: sources.href(),
		};
	});

	async function copyLink() {
		const copied = await copy(`${window.location.origin}${sources.href()}`);
		if (copied) showToast(t('shared.commandPaletteSurfaces.thread.linkCopied'));
		else showToast(t('shared.commandPaletteSurfaces.thread.linkCopyFailed'), 'error');
	}

	function followUpOptions(): PaletteArgumentOption[] {
		const outboundId = sources.followUp().outboundId;
		if (!outboundId) return [];
		return followUpPresets(new Date()).map((preset) => ({
			id: `follow-up-${preset.id}`,
			label: t(preset.labelKey),
			subtitle: t(preset.subKey),
			run: () => void followUp.arm(outboundId, preset.at),
		}));
	}

	registerCommandPaletteProvider({
		id: `${POSTBOX_THREAD_COMMAND_PROVIDER_ID_PREFIX}:${instanceId}`,
		priority: POSTBOX_THREAD_COMMAND_PROVIDER_PRIORITY,
		matchRoute: matchPostboxRoute,
		build: ({ query, mode }) => {
			if (mountedReaders.value[mountedReaders.value.length - 1] !== instanceId) return [];
			return buildThreadSurfaceGroups(
				{
					subject: sources.subject,
					t,
					isMuted: sources.isMuted,
					isAlerted: sources.isAlerted,
					followUp: () => sources.followUp().state,
					canTranslate: sources.canTranslate,
					snoozeOptions: () =>
						snoozeOptions({
							hintText: sources.hintText(),
							onSnooze: sources.snooze,
							onUntilReply: sources.snoozeUntilReply,
							onPickTime: () => sources.runAction('snooze'),
						}),
					labelOptions: () =>
						sources.labels().map((label) => ({
							id: `label-${label._id}`,
							label: label.name,
							run: () => sources.applyLabel(label._id as Id<'mailLabels'>),
						})),
					folderOptions: () =>
						sources.folders().map((folder) => ({
							id: `folder-${folder._id}`,
							label: postboxFolderLabel(t, folder),
							run: () => sources.moveTo(folder._id as Id<'mailFolders'>),
						})),
					followUpOptions,
					onReply: () => sources.runAction('reply'),
					onArchive: () => sources.runAction('archive'),
					onForward: () => sources.runAction('forward'),
					onMarkUnread: () => sources.runAction('markUnread'),
					onToggleMute: sources.toggleMute,
					onToggleAlert: sources.toggleAlert,
					onCancelFollowUp: () => {
						const threadId = sources.threadId();
						if (threadId) void followUp.cancel(threadId);
					},
					onShowOriginal: () => void original.downloadOriginal(sources.messageId()),
					onTranslate: sources.translate,
					onCopyLink: () => void copyLink(),
				},
				query,
				mode
			);
		},
	});
}
