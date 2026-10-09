/**
 * The actions of a team thread (SPEC §7 "Team"): `brief.get` in actions mode
 * for an agent Team Inbox thread or a shared-mailbox thread, in the UI's
 * locale. The first item page only; the strip says when the lists are cut.
 *
 * A thread with nothing interpreted yet is handed to the first-open
 * interpretation once (useBriefEnsure).
 *
 * `view` is `undefined` while loading and `null` when there is nothing to
 * show (no access, or a personal thread whose brief is not a team view).
 */
import { api } from '@owlat/api';
import type { TeamOpenItemsView } from '../../../../api/convex/mail/interpret/briefShape';
import { briefLocale } from '~/composables/threadBrief/briefApi';
import type { TeamStreamTarget } from '~/composables/team/useTeamStream';
import { useBriefEnsure } from '~/composables/threadBrief/useBriefEnsure';

export function useTeamOpenItems(opts: { target: () => TeamStreamTarget | null }) {
	const { locale } = useI18n();
	const query = useConvexQuery(api.mail.interpret.brief.get, () => {
		const target = opts.target();
		return target ? { threadRef: target, locale: briefLocale(locale.value) } : ('skip' as const);
	});
	const view = computed<TeamOpenItemsView | null | undefined>(() => {
		const data = query.data.value;
		if (data === undefined) return undefined;
		return data?.mode === 'actions' ? data : null;
	});
	// A thread from before the brief (D5): interpret it on first open.
	useBriefEnsure({
		threadRef: () => opts.target(),
		completeness: () => query.data.value?.completeness,
		history: () => query.data.value?.history,
	});
	return { view, isLoading: query.isLoading };
}
