/**
 * Answer mode's catch-up card, as data (plan §03): the cached summary and
 * asks of the thread being answered. Which items the draft covers is the
 * response plan's now (`useResponsePlan`).
 *
 *  - `ensure` runs once per open (per thread and locale): it returns the cache
 *    or generates it. The card reads the cache through the reactive `get`
 *    subscription, so a summary regenerated elsewhere (a new message made the
 *    old one stale) repaints here too. A failure (AI off, budget spent, a model
 *    fault) hides the card; the thread still shows.
 *  - which conversation view opens, when the host hands over its `view`:
 *    Summary when there is a card; with no card a short thread opens in full,
 *    since there is nothing to summarise.
 *
 * The Postbox (`messageId`) and the team inbox (`threadId`) have the same
 * functions under different paths; the target picks which.
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

export function useAnswerCatchUp(opts: {
	target: () => AnswerCatchUpTarget | null;
	/** The conversation's view and message count, for the opening view. */
	view?: Ref<AnswerConversationView>;
	messageCount?: () => number | undefined;
}) {
	const { locale } = useI18n();
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
			const target = opts.target();
			if (key && target) void runEnsure(target);
		},
		{ immediate: true }
	);

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

	return { catchUp, loading };
}
