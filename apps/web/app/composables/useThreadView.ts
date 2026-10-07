/**
 * Overview or Conversation for the open Postbox thread (SPEC §7), wired to the
 * route, the saved default and the per-thread choice. The precedence itself is
 * the pure `resolveThreadView` (utils/threadBriefView).
 *
 *  - `setView` is the switch: it shows the view at once and saves it as this
 *    viewer's choice for this thread (`threadViewerState.viewOverride`).
 *  - `openCite` switches to Conversation for this visit only, through
 *    `?cite=`; it never writes a preference. `backToOverview` drops the cite
 *    and returns to the Overview, again without writing.
 *  - `?view=` (a link from the Workbench or a notification) is read, never saved.
 */
import type { ThreadView } from '@owlat/shared/threadBrief';
import type { BriefModeView } from '../../../api/convex/mail/interpret/briefShape';
import { interpretApi, type MailThreadRefArg } from '~/composables/threadBrief/briefApi';
import {
	formatCite,
	parseCite,
	parseQueryView,
	resolveThreadView,
	type BriefAvailability,
	type CiteParam,
	type ResolvedThreadView,
} from '~/utils/threadBriefView';

export function useThreadView(opts: {
	threadRef: () => MailThreadRefArg | null;
	brief: () => BriefModeView | null | undefined;
	availability: () => BriefAvailability;
	/** A shared (team) mailbox: Conversation only, nothing is read or written. */
	isShared: () => boolean;
}) {
	const { t } = useI18n();
	const route = useRoute();
	const router = useRouter();

	const preference = useConvexQuery(interpretApi.preferences.getViewPreference, () =>
		opts.isShared() ? ('skip' as const) : {}
	);
	const savedDefault = computed<ThreadView | undefined>(
		() =>
			preference.data.value?.threadDefaultView ?? (preference.error.value ? 'overview' : undefined)
	);

	// What the viewer clicked in this visit; a different thread starts afresh.
	const sessionChoice = ref<ThreadView | null>(null);
	watch(
		() => opts.threadRef()?.id,
		() => {
			sessionChoice.value = null;
		}
	);

	const cite = computed<CiteParam | null>(() => parseCite(route.query['cite']));

	const view = computed<ResolvedThreadView>(() =>
		resolveThreadView({
			isShared: opts.isShared(),
			hasCite: cite.value !== null,
			queryView: parseQueryView(route.query['view']),
			sessionChoice: sessionChoice.value,
			override: opts.brief()?.viewOverride ?? null,
			savedDefault: savedDefault.value,
			availability: opts.availability(),
		})
	);

	const overrideOp = useBackendOperation(interpretApi.brief.setViewOverride, {
		label: () => t('components.brief.operations.saveView'),
		announce: false,
	});

	function withoutViewParams() {
		const { view: _view, cite: _cite, ...rest } = route.query;
		return rest;
	}

	/** The switch: show `next` now and remember it for this thread. */
	function setView(next: ThreadView) {
		sessionChoice.value = next;
		if (route.query['view'] !== undefined || route.query['cite'] !== undefined) {
			void router.replace({ query: withoutViewParams() });
		}
		const ref = opts.threadRef();
		if (ref && opts.brief()?.viewOverride !== next) {
			void overrideOp.run({ threadRef: ref, view: next });
		}
	}

	/** Show where a line of the brief comes from: Conversation, for this visit only. */
	function openCite(next: CiteParam) {
		void router.replace({ query: { ...withoutViewParams(), cite: formatCite(next) } });
	}

	/** Leave the cited source and return to the Overview, writing nothing. */
	function backToOverview() {
		sessionChoice.value = 'overview';
		void router.replace({ query: withoutViewParams() });
	}

	return { view, cite, setView, openCite, backToOverview };
}
