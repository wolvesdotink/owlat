/**
 * The Postbox reader's side of a shared (team) mailbox thread (SPEC §7
 * "Team"): no Overview there; the reader keeps rendering the emails, and the
 * team stream fills in around them. This places the stream's internal notes
 * (the thread's discussion) and system lines between the reader's messages,
 * pins "Open for the team" above them and drives the team composer.
 *
 * With the `chat` feature off the stream carries no notes and the composer
 * offers the reply only: email, actions and activity stay.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import { useTeamThread } from '~/composables/team/useTeamThread';
import { placeStreamExtras } from '~/utils/teamStream';

interface ReaderMessageLike {
	_id: string;
	receivedAt: number;
}

/** Older stream pages one walk loads to reach the reader's oldest loaded message. */
const MAX_CATCH_UP_PAGES = 10;

export function usePostboxTeamStream(opts: {
	isShared: () => boolean;
	threadId: () => string | null | undefined;
	messages: () => readonly ReaderMessageLike[];
	/** Open Answer mode on the thread (behind the reply guard). */
	reply: (text: string) => void;
}) {
	const { t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const isActive = computed(() => opts.isShared() && !!opts.threadId());
	const team = useTeamThread({
		target: () =>
			isActive.value ? { kind: 'mail', id: opts.threadId() as Id<'mailThreads'> } : null,
		onReply: () => opts.reply(''),
	});
	const notesEnabled = computed(() => isEnabled('chat'));

	/** Notes and system lines, each placed after the email it follows in the stream. */
	const placement = computed(() => {
		const loaded = new Set(opts.messages().map((m) => m._id));
		return placeStreamExtras(team.stream.entries.value, (entry) => {
			const id = entry.source?.id;
			return id && loaded.has(id) ? id : null;
		});
	});
	const leading = computed(() => (isActive.value ? placement.value.leading : []));
	function after(messageId: string): TeamStreamEntry[] {
		return isActive.value ? (placement.value.after.get(messageId) ?? []) : [];
	}

	// Walk the stream back as far as the reader shows messages, a bounded number
	// of pages per walk. Where a walk stops short, the reader says so and offers
	// the rest (`earlier`, `loadEarlier`): nothing is dropped silently.
	const caughtUp = ref(0);
	watch(opts.threadId, () => {
		caughtUp.value = 0;
	});
	const isBehind = computed(() => {
		const oldestMessage = opts.messages()[0]?.receivedAt;
		const oldestEntry = team.stream.entries.value[0]?.at;
		return (
			isActive.value &&
			team.stream.hasEarlier.value &&
			oldestMessage !== undefined &&
			oldestEntry !== undefined &&
			oldestEntry > oldestMessage
		);
	});
	watch(
		() => isBehind.value && !team.stream.isLoadingEarlier.value,
		(shouldWalk) => {
			if (!shouldWalk || caughtUp.value >= MAX_CATCH_UP_PAGES) return;
			caughtUp.value++;
			team.stream.loadEarlier();
		},
		{ immediate: true }
	);
	/**
	 * What the reader says above its first message about the stream's older
	 * entries: still loading, stopped short of the messages shown (`cut`), or
	 * more of them before the first message shown (`more`).
	 */
	const earlier = computed<'none' | 'loading' | 'cut' | 'more'>(() => {
		if (!isActive.value || !team.stream.hasEarlier.value) return 'none';
		if (team.stream.isLoadingEarlier.value) return 'loading';
		if (isBehind.value) return caughtUp.value >= MAX_CATCH_UP_PAGES ? 'cut' : 'loading';
		return 'more';
	});
	/** Load the next older page, and let the walk go on from there. */
	function loadEarlier() {
		caughtUp.value = 0;
		team.stream.loadEarlier();
	}

	// What the viewer has seen of the stream ("New" next time), and their
	// @mentions in the thread's discussion (the panel used to clear them).
	const markReadOp = useBackendOperation(api.chat.mailDiscussion.markRead, {
		label: () => t('components.postbox.threadDiscussion.markReadOperation'),
		announce: false,
	});
	const readThreads = new Set<string>();
	watch(
		() => (isActive.value ? team.stream.entries.value.at(-1)?.key : undefined),
		(key) => {
			if (!key) return;
			team.stream.markSeen();
			const threadId = opts.threadId();
			const hasDiscussion = team.stream.entries.value.some(
				(e) => e.kind === 'note' && e.noteSource === 'chatMessage'
			);
			if (!threadId || !notesEnabled.value || !hasDiscussion || readThreads.has(threadId)) return;
			readThreads.add(threadId);
			void markReadOp.run({ threadId: threadId as Id<'mailThreads'> });
		}
	);

	// The reply's unsent text, per thread for the session.
	const replyDrafts = useState<Record<string, string>>('postbox:team-reply-drafts', () => ({}));
	const replyDraft = computed({
		get: () => replyDrafts.value[opts.threadId() ?? ''] ?? '',
		set: (text: string) => {
			replyDrafts.value = { ...replyDrafts.value, [opts.threadId() ?? '']: text };
		},
	});
	function continueReply(text: string) {
		opts.reply(text);
		replyDraft.value = '';
	}

	return {
		isActive,
		team,
		notesEnabled,
		leading,
		after,
		earlier,
		loadEarlier,
		replyDraft,
		continueReply,
	};
}

export type PostboxTeamStream = ReturnType<typeof usePostboxTeamStream>;
