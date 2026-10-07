/**
 * Answer mode's response plan (SPEC §6, plan §6), for the Postbox (`m/`) and
 * the Team inbox (`t/`) composer alike: one stance per open item the reply
 * covers, and what the draft addresses.
 *
 *  - stances: the server's plan (`responsePlan.get`, default stances included)
 *    with the person's choices on top. A choice is stored on the draft's plan
 *    (`setStances`) once the draft exists; before that it is kept here and
 *    written with the first save. Unselecting an item is the stance `skip`.
 *  - coverage: once typing pauses (and right after an AI draft lands) the
 *    draft's plain text goes to `coverage.check`, which returns per item
 *    whether the draft addresses it, the files it says are attached that are
 *    not, and the promises it makes. A newer check wins over one in flight;
 *    the same text is not checked twice. Until a check ran here, the draft's
 *    stored coverage shows, if it is current.
 *  - the footer's line: "3 of 4 addressed · 1 needs a file · new promise
 *    noted: …", nothing before something is written.
 *
 * Coverage only ever says "Addressed in draft": nothing here changes an item.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ResponseStance } from '@owlat/shared/threadBrief';
import type { FunctionReturnType } from 'convex/server';
import type { BriefItemView } from '../../../api/convex/mail/interpret/briefShape';
import {
	fileMissingItemIds,
	planStatusOf,
	type PlanCoverageEntry,
	type ResponsePlanView,
} from '~/utils/responsePlan';

/** How long typing must pause before the draft is checked against the plan. */
export const PLAN_COVERAGE_DEBOUNCE_MS = 1500;

export type PlanThreadRef =
	| { kind: 'mail'; id: Id<'mailThreads'> }
	| { kind: 'team'; id: Id<'conversationThreads'> };
export type PlanDraftRef =
	| { kind: 'mailDraft'; id: Id<'mailDrafts'> }
	| { kind: 'inboundDraft'; id: Id<'inboundMessages'> };

type CoverageResult = NonNullable<FunctionReturnType<typeof api.mail.interpret.coverage.check>>;

export function useResponsePlan(opts: {
	threadRef: () => PlanThreadRef | null;
	draftRef: () => PlanDraftRef | null;
	/** The plain text of what the draft says (quote and signature left out). */
	draftText: () => string;
	/** The brief's items the reply plans for (`isPlanItem`), in brief order. */
	items: () => readonly BriefItemView[];
}) {
	const { t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const aiOn = computed(() => isEnabled('ai'));

	const stored = useConvexQuery(api.mail.interpret.responsePlan.get, () => {
		const threadRef = opts.threadRef();
		if (!threadRef) return 'skip' as const;
		const draftRef = opts.draftRef();
		return draftRef ? { threadRef, draftRef } : { threadRef };
	});

	/** The person's choices not yet confirmed by the stored plan. */
	const chosen = ref(new Map<string, ResponseStance>());
	/** This page's last coverage check, and what it checked. */
	const checked = shallowRef<CoverageResult | null>(null);
	let lastChecked: string | null = null;
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const keyOf = () => {
		const threadRef = opts.threadRef();
		return threadRef ? `${threadRef.kind}:${threadRef.id}` : null;
	};
	watch(keyOf, () => {
		chosen.value = new Map();
		checked.value = null;
		lastChecked = null;
	});

	const stances = computed(() => {
		const out = new Map<string, ResponseStance>();
		const server = new Map((stored.data.value?.stances ?? []).map((s) => [s.itemId, s.stance]));
		for (const item of opts.items()) {
			out.set(item.id, chosen.value.get(item.id) ?? server.get(item.id) ?? 'answer');
		}
		return out;
	});
	const selected = computed(() =>
		[...stances.value].filter(([, stance]) => stance !== 'skip').map(([id]) => id)
	);

	// Writing the choices onto the draft's plan
	let writing: Promise<void> = Promise.resolve();
	function persist() {
		const threadRef = opts.threadRef();
		const draftRef = opts.draftRef();
		if (!threadRef || !draftRef || chosen.value.size === 0) return;
		const given = [...chosen.value].map(([itemId, stance]) => ({
			itemId: itemId as Id<'threadItems'>,
			stance,
		}));
		writing = writing
			.then(() =>
				requireConvex().mutation(api.mail.interpret.responsePlan.setStances, {
					threadRef,
					draftRef,
					stances: given,
				})
			)
			.then(() => undefined)
			.catch(() => {
				// The choice stays on screen and goes with the next write or check.
			});
	}
	watch(() => opts.draftRef()?.id, persist);

	function setStance(itemId: string, stance: ResponseStance) {
		const next = new Map(chosen.value);
		next.set(itemId, stance);
		chosen.value = next;
		persist();
		scheduleCoverage();
	}

	/** Select exactly these items: the rest are skipped, a reselected one answers again. */
	function setSelected(ids: readonly string[]) {
		const want = new Set(ids);
		const next = new Map(chosen.value);
		for (const [id, stance] of stances.value) {
			if (!want.has(id) && stance !== 'skip') next.set(id, 'skip');
			if (want.has(id) && stance === 'skip') next.set(id, 'answer');
		}
		chosen.value = next;
		persist();
		scheduleCoverage();
	}

	// Coverage
	async function checkCoverage() {
		clearTimeout(timer);
		const threadRef = opts.threadRef();
		const draftRef = opts.draftRef();
		const text = opts.draftText().trim();
		if (!threadRef || !draftRef || !aiOn.value || stances.value.size === 0) return;
		const stanceList = [...stances.value].map(([itemId, stance]) => ({
			itemId: itemId as Id<'threadItems'>,
			stance,
		}));
		const key = `${draftRef.id}:${JSON.stringify(stanceList)}:${text}`;
		if (key === lastChecked) return;
		lastChecked = key;
		const mine = ++seq;
		if (!text) {
			checked.value = null;
			return;
		}
		try {
			const result = await requireConvex().action(api.mail.interpret.coverage.check, {
				threadRef,
				draftRef,
				draftText: text,
				stances: stanceList,
			});
			if (mine === seq) checked.value = result;
		} catch {
			// No chips is the honest answer when the check could not run.
			if (mine === seq) lastChecked = null;
		}
	}

	function scheduleCoverage() {
		clearTimeout(timer);
		timer = setTimeout(() => void checkCoverage(), PLAN_COVERAGE_DEBOUNCE_MS);
	}
	watch(opts.draftText, scheduleCoverage);
	onBeforeUnmount(() => clearTimeout(timer));

	/** The coverage on screen: this page's last check, else the draft's stored one when current. */
	const coverage = computed(() => {
		if (checked.value) return checked.value;
		const view = stored.data.value;
		if (!view || view.isStale || view.verdict === 'pending' || !view.draftHash) return null;
		return { ...view, isChecked: true };
	});
	const coverageEntries = computed<PlanCoverageEntry[]>(() => coverage.value?.coverage ?? []);
	const addressed = computed(() =>
		coverageEntries.value
			.filter((c) => c.verdict === 'addressed' && stances.value.get(c.itemId) !== 'skip')
			.map((c) => c.itemId)
	);
	const missingFiles = computed(() =>
		(coverage.value?.fileClaims ?? []).filter((c) => !c.isMatched).map((c) => c.text)
	);
	const fileMissing = computed(() =>
		fileMissingItemIds(opts.items(), coverageEntries.value, coverage.value?.fileClaims ?? [])
	);

	const status = computed(() =>
		planStatusOf({
			stances: stances.value,
			coverage: coverageEntries.value,
			fileClaims: coverage.value?.fileClaims ?? [],
			newPromises: coverage.value?.newPromises ?? [],
			isChecked: coverage.value?.isChecked ?? false,
			hasText: !!opts.draftText().trim(),
		})
	);
	const statusNote = computed(() => {
		const s = status.value;
		if (!s) return undefined;
		const parts: string[] = [];
		if (s.total > 0) {
			parts.push(
				t('components.answer.plan.status.addressed', { addressed: s.addressed, total: s.total })
			);
		}
		if (s.needsFile > 0) {
			parts.push(t('components.answer.plan.status.needsFile', { count: s.needsFile }, s.needsFile));
		}
		if (s.promise) parts.push(t('components.answer.plan.status.promise', { text: s.promise }));
		return parts.join(' · ');
	});

	const view: ResponsePlanView = {
		stanceOf: (itemId) => stances.value.get(itemId) ?? 'answer',
		setStance,
		addressed,
		fileMissing,
	};

	return {
		view,
		/** The items the reply plans for. */
		items: computed(() => opts.items()),
		stances,
		selected,
		setSelected,
		setStance,
		addressed,
		missingFiles,
		statusNote,
		/** Check the draft now (an AI draft just landed). */
		checkCoverage,
		/** Check again after a pause even if the text is the same (a file was attached). */
		recheck: () => {
			lastChecked = null;
			scheduleCoverage();
		},
		/** The choices are written before the AI drafts from them. */
		flush: () => writing,
	};
}

export type ResponsePlan = ReturnType<typeof useResponsePlan>;
