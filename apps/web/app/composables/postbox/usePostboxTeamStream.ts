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
import type { Id } from '@owlat/api/dataModel';
import type { TeamStreamEntry } from '../../../../api/convex/mail/interpret/briefShape';
import { useTeamThread } from '~/composables/team/useTeamThread';
import { placeStreamExtras } from '~/utils/teamStream';

interface ReaderMessageLike {
	_id: string;
	receivedAt: number;
}

/** Older stream pages walked to reach the reader's oldest loaded message. */
const MAX_CATCH_UP_PAGES = 10;

export function usePostboxTeamStream(opts: {
	isShared: () => boolean;
	threadId: () => string | null | undefined;
	messages: () => readonly ReaderMessageLike[];
	/** Open Answer mode on the thread (behind the reply guard). */
	reply: (text: string) => void;
}) {
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

	// Walk the stream back as far as the reader shows messages (bounded per thread).
	let caughtUp = 0;
	watch(opts.threadId, () => {
		caughtUp = 0;
	});
	watch(
		() => {
			const oldestMessage = opts.messages()[0]?.receivedAt;
			const oldestEntry = team.stream.entries.value[0]?.at;
			return (
				isActive.value &&
				team.stream.hasEarlier.value &&
				!team.stream.isLoadingEarlier.value &&
				oldestMessage !== undefined &&
				oldestEntry !== undefined &&
				oldestEntry > oldestMessage
			);
		},
		(isBehind) => {
			if (!isBehind || caughtUp >= MAX_CATCH_UP_PAGES) return;
			caughtUp++;
			team.stream.loadEarlier();
		},
		{ immediate: true }
	);

	// What the viewer has seen of the stream ("New" next time).
	watch(
		() => (isActive.value ? team.stream.entries.value.at(-1)?.key : undefined),
		(key) => key && team.stream.markSeen()
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

	return { isActive, team, notesEnabled, leading, after, replyDraft, continueReply };
}

export type PostboxTeamStream = ReturnType<typeof usePostboxTeamStream>;
