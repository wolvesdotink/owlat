/**
 * Source markers on team surfaces (SPEC §7 "Team"): who sent a cited email
 * and when (read from the stream; a reply names its author, never its
 * recipient), and what a click does: bring that email into view and ring it,
 * walking the stream back until it is loaded, or hand it to a host that pages
 * the emails itself (the shared-mailbox reader). The `BRIEF_CONTEXT` every
 * team brief component (strip, Answer mode's plan) provides.
 */
import type { Ref } from 'vue';
import type { TeamOpenItemsView } from '../../../../api/convex/mail/interpret/briefShape';
import type { TeamStream } from '~/composables/team/useTeamStream';
import type { BriefContext } from '~/utils/threadBriefContext';
import { citedMessageId, streamSources } from '~/utils/teamCite';

export function useTeamCite(opts: {
	stream: TeamStream;
	view: Readonly<Ref<TeamOpenItemsView | null | undefined>>;
	memberName: (userId: string) => string;
	/** Show a message through the host's own paging, when it has one. */
	citeMessage?: () => ((messageId: string) => void) | undefined;
}): BriefContext {
	const { t } = useI18n();
	const sources = computed(() =>
		streamSources(opts.stream.entries.value, (entry) => {
			if (entry.isAgent) return t('dashboard.inbox.detail.outbound.agent');
			return entry.authorUserId
				? opts.memberName(entry.authorUserId)
				: t('dashboard.inbox.detail.outbound.yourTeam');
		})
	);
	/** The email a marker asked for, while older pages are still loading. */
	const wanted = ref<string | null>(null);

	function show(messageId: string): boolean {
		const el = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
		if (!el) return false;
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
		el.classList.add('ring-2', 'ring-brand/50');
		setTimeout(() => el.classList.remove('ring-2', 'ring-brand/50'), 1600);
		return true;
	}

	/** Show the wanted email, loading older stream pages until it is there. */
	function seek() {
		const id = wanted.value;
		if (!id) return;
		if (show(id)) {
			wanted.value = null;
			return;
		}
		if (opts.stream.hasEarlier.value) opts.stream.loadEarlier();
		else wanted.value = null;
	}
	watch(
		() => opts.stream.entries.value.length,
		() => void nextTick(seek)
	);

	return {
		sourceOf: (messageId) => sources.value.get(messageId),
		cite(ref, quoteIndex) {
			const id = citedMessageId(opts.view.value, ref, quoteIndex);
			if (!id) return;
			const host = opts.citeMessage?.();
			if (host) {
				host(id);
				return;
			}
			wanted.value = id;
			void nextTick(seek);
		},
	};
}
