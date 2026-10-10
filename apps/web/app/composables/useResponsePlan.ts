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
import { draftHashOf } from '@owlat/shared/threadBriefRules';
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
	const { showToast } = useToast();
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

	// A choice for an item that left the plan (closed, done, replaced) is
	// dropped: writing it again would be refused and block every later write,
	// check and draft (review r4 F1).
	watch(
		() => opts.items().map((i) => i.id),
		(ids) => {
			const open = new Set<string>(ids);
			if ([...chosen.value.keys()].every((id) => open.has(id))) return;
			chosen.value = new Map([...chosen.value].filter(([id]) => open.has(id)));
		}
	);

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

	// Writing the choices onto the draft's plan. A failed write is said, and
	// rejects `flush`, so nothing that reads the stored stances (the drafter,
	// the check) runs on old ones (review r2 F4).
	let writing: Promise<void> = Promise.resolve();
	/** Writes in flight: until they land, no coverage on screen is trusted. */
	const pendingWrites = ref(0);
	function persist(explicit?: PlanDraftRef | null): Promise<void> {
		const threadRef = opts.threadRef();
		const draftRef = explicit ?? opts.draftRef();
		const open = new Set<string>(opts.items().map((i) => i.id));
		const current = [...chosen.value].filter(([id]) => open.has(id));
		if (!threadRef || !draftRef || current.length === 0) return writing;
		const given = current.map(([itemId, stance]) => ({
			itemId: itemId as Id<'threadItems'>,
			stance,
		}));
		pendingWrites.value++;
		const attempt = writing.then(() =>
			requireConvex().mutation(api.mail.interpret.responsePlan.setStances, {
				threadRef,
				draftRef,
				stances: given,
			})
		);
		writing = attempt
			.then(
				() => undefined,
				() => {
					showToast(t('components.answer.plan.writeFailed'), 'error');
				}
			)
			.finally(() => {
				pendingWrites.value--;
			});
		return attempt.then(() => undefined);
	}
	const persistQuietly = (explicit?: PlanDraftRef | null) =>
		persist(explicit).catch(() => {
			// Said by the toast; the choice stays on screen for the next write.
		});
	watch(
		() => opts.draftRef()?.id,
		() => void persistQuietly()
	);

	/** Every choice on screen is the stored one: until then no coverage counts. */
	const isAcknowledged = computed(() => {
		const server = new Map(
			(stored.data.value?.stances ?? []).map((s) => [s.itemId as string, s.stance])
		);
		const open = new Set<string>(opts.items().map((i) => i.id));
		return [...chosen.value].every(([id, stance]) => !open.has(id) || server.get(id) === stance);
	});

	/** The thread and item revisions on screen; a result for others is stale (r2 F3). */
	const revisionsKey = computed(() => {
		const items = opts
			.items()
			.map((i) => `${i.id}@${i.revision}`)
			.sort()
			.join(',');
		return `${stored.data.value?.threadRevision ?? '?'}|${items}`;
	});
	/** Requests in flight: a revision change during one is followed by a fresh check. */
	const inFlight = ref(0);
	/** The binding key of a check: its thread revision and its COMPLETE item set. */
	function bindingKey(
		threadRevision: number | undefined,
		itemRevisions: readonly { itemId: string; revision: number }[]
	): string {
		const items = itemRevisions
			.map((r) => `${r.itemId}@${r.revision}`)
			.sort()
			.join(',');
		return `${threadRevision ?? '?'}|${items}`;
	}
	const resultRevisionsKey = (result: CoverageResult) =>
		bindingKey(result.threadRevision, result.itemRevisions);

	function setStance(itemId: string, stance: ResponseStance) {
		const next = new Map(chosen.value);
		next.set(itemId, stance);
		chosen.value = next;
		void persistQuietly();
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
		void persistQuietly();
		scheduleCoverage();
	}

	/** The hash of the text in the editor now, which a result must match (review D1). */
	const currentHash = ref<string | null>(null);
	let hashSeq = 0;
	watch(
		opts.draftText,
		(text) => {
			const mine = ++hashSeq;
			currentHash.value = null;
			void draftHashOf(text).then((hash) => {
				if (mine === hashSeq) currentHash.value = hash;
			});
		},
		{ immediate: true }
	);

	// Coverage. The check reads the STORED stances, so the choices are written
	// first; its result is bound to the plan revision and the text it read.
	async function checkCoverage() {
		clearTimeout(timer);
		const threadRef = opts.threadRef();
		const draftRef = opts.draftRef();
		const text = opts.draftText().trim();
		if (!threadRef || !draftRef || !aiOn.value) return;
		try {
			await persist();
		} catch {
			return; // the stances on screen are not stored: no check of the old ones
		}
		const key = `${draftRef.id}:${stored.data.value?.planRevision ?? 0}:${revisionsKey.value}:${JSON.stringify([...chosen.value])}:${text}`;
		if (key === lastChecked) return;
		lastChecked = key;
		const mine = ++seq;
		if (!text) {
			checked.value = null;
			return;
		}
		inFlight.value++;
		try {
			const result = await requireConvex().action(api.mail.interpret.coverage.check, {
				threadRef,
				draftRef,
				draftText: text,
			});
			// A result stale on arrival (items moved while it ran) stays hidden; the
			// revision watch below already scheduled the next check (r3 F3).
			if (mine === seq) checked.value = result;
		} catch {
			// No chips is the honest answer when the check could not run.
			if (mine === seq) lastChecked = null;
		} finally {
			inFlight.value--;
		}
	}

	function scheduleCoverage() {
		clearTimeout(timer);
		timer = setTimeout(() => void checkCoverage(), PLAN_COVERAGE_DEBOUNCE_MS);
	}
	watch(opts.draftText, scheduleCoverage);
	// An item or the thread changed: whatever was checked (here, in flight, or
	// stored) no longer counts, so check again (review r3 F1, F3).
	watch(revisionsKey, () => {
		if (!opts.draftText().trim()) return;
		lastChecked = null;
		scheduleCoverage();
	});
	onBeforeUnmount(() => clearTimeout(timer));

	/**
	 * The coverage on screen: only a result bound to exactly what is on screen
	 * now (review D1, F10): the editor's text (draft hash), the stored stance
	 * revision, and no stance write still in flight. This page's last check
	 * first, else the draft's stored check. Anything else is "checking".
	 */
	const coverage = computed(() => {
		const view = stored.data.value;
		const revision = view?.planRevision ?? 0;
		const hash = currentHash.value;
		if (!hash || pendingWrites.value > 0 || !isAcknowledged.value) return null;
		const local = checked.value;
		if (
			local &&
			local.draftHash === hash &&
			local.planRevision === revision &&
			resultRevisionsKey(local) === revisionsKey.value
		) {
			return local;
		}
		if (
			view &&
			!view.isStale &&
			view.verdict !== 'pending' &&
			view.draftHash === hash &&
			view.checkedPlanRevision === revision &&
			bindingKey(view.checkedThreadRevision, view.checkedItemRevisions) === revisionsKey.value
		) {
			return { ...view, isChecked: true };
		}
		return null;
	});
	// A stored check of this very text that no longer matches the items, with
	// nothing local and no request running: check now instead of "Checking"
	// forever (review r3 F3).
	// Once per stored state, so a check that cannot help never loops.
	let stuckKey: string | null = null;
	watch(
		() =>
			!!stored.data.value?.draftHash &&
			stored.data.value.draftHash === currentHash.value &&
			!coverage.value &&
			!checked.value &&
			inFlight.value === 0
				? `${stored.data.value.planRevision}|${stored.data.value.draftHash}|${revisionsKey.value}`
				: null,
		(key) => {
			if (key && key !== stuckKey) {
				stuckKey = key;
				lastChecked = null;
				scheduleCoverage();
			}
		}
	);
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
	/** Something is written and checkable, but no result matches it yet. */
	const isChecking = computed(
		() => aiOn.value && !!opts.draftRef() && !!opts.draftText().trim() && !coverage.value
	);
	const statusNote = computed(() => {
		if (isChecking.value) return t('components.answer.plan.status.checking');
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
		/**
		 * The Reply Queue's prepared reply went into this Postbox draft: its plan,
		 * still bound to the prepared text, moves to the draft (review F16).
		 */
		adoptPreparedPlan: async (draftId: Id<'mailDrafts'>) => {
			const threadRef = opts.threadRef();
			if (threadRef?.kind !== 'mail') return;
			try {
				await requireConvex().mutation(api.mail.interpret.responsePlan.adoptArrivalPlan, {
					threadRef,
					draftId,
				});
			} catch {
				// The draft is checked afresh instead.
			}
		},
		/**
		 * Write the choices (to `draftRef` when the draft was just created) and
		 * wait. Rejects when the write failed: the caller must not go on.
		 */
		flush: (draftRef?: PlanDraftRef | null) => persist(draftRef),
	};
}

export type ResponsePlan = ReturnType<typeof useResponsePlan>;
