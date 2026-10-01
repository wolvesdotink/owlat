/**
 * Answer mode's catch-up card, as data (plan §03): the cached summary and
 * asks of the thread being answered, and which asks the draft covers.
 *
 *  - `ensure` runs once per open (per thread and locale): it returns the cache
 *    or generates it. The card reads the cache through the reactive `get`
 *    subscription, so a summary regenerated elsewhere (a new message made the
 *    old one stale) repaints here too. A failure (AI off, budget spent, a model
 *    fault) hides the card; the thread still shows.
 *  - coverage: once the person stops typing for a moment (and right after an AI
 *    draft lands), the draft's plain text goes to `coverage`, which returns the
 *    ask ids it covers. A newer check always wins over an older one still in
 *    flight; an empty draft covers nothing without asking the server.
 *
 *    The same text is never checked twice against the same card: an AI draft
 *    that lands both settles (checked at once) and changes the text (which
 *    would check again after the pause).
 *  - the footer's note ("2 of 3 asks covered"), once something is written;
 *  - which conversation view opens, when the host hands over its `view`:
 *    Summary when there is a card; with no card a short thread opens in full,
 *    since there is nothing to summarise.
 *
 * The Postbox (`messageId`) and the team inbox (`threadId`) have the same
 * three functions under different paths; the target picks which.
 */
import type { Ref } from 'vue';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { CATCH_UP_MIN_MESSAGES } from '@owlat/shared/answerMode';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';

export type CatchUp = NonNullable<FunctionReturnType<typeof api.mail.ai.catchUpStore.get>>;

export type AnswerCatchUpTarget =
	| { kind: 'mail'; messageId: Id<'mailMessages'> }
	| { kind: 'team'; threadId: Id<'conversationThreads'> };

/** How long typing must pause before the draft is checked against the asks. */
export const COVERAGE_DEBOUNCE_MS = 1500;

export function useAnswerCatchUp(opts: {
	target: () => AnswerCatchUpTarget | null;
	/** The plain text of what the draft says (quote and signature left out). */
	draftText: () => string;
	/** The conversation's view and message count, for the opening view. */
	view?: Ref<AnswerConversationView>;
	messageCount?: () => number | undefined;
}) {
	const { locale, t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const aiOn = computed(() => isEnabled('ai'));

	const mailArgs = () => {
		const target = opts.target();
		return aiOn.value && target?.kind === 'mail'
			? { messageId: target.messageId, locale: locale.value }
			: ('skip' as const);
	};
	const teamArgs = () => {
		const target = opts.target();
		return aiOn.value && target?.kind === 'team'
			? { threadId: target.threadId, locale: locale.value }
			: ('skip' as const);
	};
	const mailStore = useConvexQuery(api.mail.ai.catchUpStore.get, mailArgs);
	const teamStore = useConvexQuery(api.inbox.catchUpStore.get, teamArgs);

	/** What `ensure` answered, shown until the subscription has caught up. */
	const ensured = shallowRef<CatchUp | null | undefined>(undefined);
	const pending = ref(false);
	const failed = ref(false);
	const coveredAskIds = ref<string[]>([]);
	/** The card and text of the last coverage check, so an unchanged draft is not re-sent. */
	let lastChecked: string | null = null;

	const catchUp = computed<CatchUp | null>(() => {
		if (failed.value) return null;
		const stored = opts.target()?.kind === 'team' ? teamStore.data.value : mailStore.data.value;
		return stored ?? ensured.value ?? null;
	});
	/** A quiet skeleton while the first answer is on its way. */
	const loading = computed(() => pending.value && !catchUp.value);

	function keyOf(target: AnswerCatchUpTarget | null): string | null {
		if (!target || !aiOn.value) return null;
		const id = target.kind === 'mail' ? target.messageId : target.threadId;
		return `${target.kind}:${id}:${locale.value}`;
	}

	let ensureSeq = 0;
	async function runEnsure(target: AnswerCatchUpTarget) {
		const seq = ++ensureSeq;
		pending.value = true;
		failed.value = false;
		ensured.value = undefined;
		try {
			const convex = requireConvex();
			const result =
				target.kind === 'mail'
					? await convex.action(api.mail.ai.catchUp.ensure, {
							messageId: target.messageId,
							locale: locale.value,
						})
					: await convex.action(api.inbox.catchUp.ensure, {
							threadId: target.threadId,
							locale: locale.value,
						});
			if (seq === ensureSeq) ensured.value = result;
		} catch {
			// The card is a convenience: a refusal or a fault hides it, silently.
			if (seq === ensureSeq) failed.value = true;
		} finally {
			if (seq === ensureSeq) pending.value = false;
		}
	}

	watch(
		() => keyOf(opts.target()),
		(key) => {
			coveredAskIds.value = [];
			lastChecked = null;
			const target = opts.target();
			if (key && target) void runEnsure(target);
		},
		{ immediate: true }
	);

	// Coverage
	let coverageSeq = 0;
	let coverageTimer: ReturnType<typeof setTimeout> | undefined;

	async function checkCoverage() {
		clearTimeout(coverageTimer);
		const target = opts.target();
		const card = catchUp.value;
		const text = opts.draftText().trim();
		if (!target || !card || card.asks.length === 0) return;
		const key = `${card.generatedAt}:${text}`;
		if (key === lastChecked) return;
		const seq = ++coverageSeq;
		lastChecked = key;
		if (!text) {
			coveredAskIds.value = [];
			return;
		}
		try {
			const convex = requireConvex();
			const result =
				target.kind === 'mail'
					? await convex.action(api.mail.ai.catchUp.coverage, {
							messageId: target.messageId,
							draftText: text,
							locale: locale.value,
						})
					: await convex.action(api.inbox.catchUp.coverage, {
							threadId: target.threadId,
							draftText: text,
							locale: locale.value,
						});
			if (seq === coverageSeq) coveredAskIds.value = result.coveredAskIds;
		} catch {
			// No ticks is the honest answer when the check could not run; the
			// same text may be tried again.
			if (seq === coverageSeq) lastChecked = null;
		}
	}

	/** Check again after typing pauses. */
	function scheduleCoverage() {
		clearTimeout(coverageTimer);
		coverageTimer = setTimeout(() => void checkCoverage(), COVERAGE_DEBOUNCE_MS);
	}

	watch(opts.draftText, scheduleCoverage);
	// The asks arriving after the person already wrote something.
	watch(
		() => catchUp.value?.asks.length ?? 0,
		(count, previous) => {
			if (count > 0 && !previous) scheduleCoverage();
		}
	);
	onBeforeUnmount(() => clearTimeout(coverageTimer));

	/** Asks the draft covers, as far as the ids still exist on the card. */
	const covered = computed(() => {
		const ids = new Set(catchUp.value?.asks.map((a) => a.id) ?? []);
		return coveredAskIds.value.filter((id) => ids.has(id));
	});

	/**
	 * "2 of 3 asks covered", for the footer's save-state spot. Nothing before
	 * the person (or the AI) has written anything: "0 of 3" on an untouched
	 * reply reads like a warning.
	 */
	const statusNote = computed(() => {
		const total = catchUp.value?.asks.length ?? 0;
		if (total === 0) return undefined;
		if (covered.value.length === 0 && !opts.draftText().trim()) return undefined;
		return t('components.answer.catchUp.covered', { covered: covered.value.length, total }, total);
	});

	// Summary when there is a card; a short thread without one opens in full.
	// Decided once, so it never flips under someone who already toggled.
	const view = opts.view;
	if (view) {
		let viewDecided = false;
		watch(
			() => [loading.value, catchUp.value, opts.messageCount?.()] as const,
			([isLoading, card, count]) => {
				if (viewDecided || isLoading || count === undefined) return;
				viewDecided = true;
				if (!card && count < CATCH_UP_MIN_MESSAGES) view.value = 'full';
			},
			{ immediate: true }
		);
	}

	return {
		catchUp,
		loading,
		covered,
		statusNote,
		/** Check the draft now (an AI draft just landed). */
		checkCoverage,
	};
}
