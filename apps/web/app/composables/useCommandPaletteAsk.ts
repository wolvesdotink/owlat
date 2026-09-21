/**
 * Ask scope for the command palette: the knowledge + files question, answered
 * with citations inside the overlay.
 *
 * This is the whole of what `QuickQueryPanel` used to be — the same
 * `quickQuery.ask` action, the same `QueryResult` rendering — minus the second
 * modal it lived in. ⌘⇧K survives as an alias that opens the overlay already on
 * this scope, and `?` reaches it from anywhere.
 *
 * The `ai.knowledge` gate stays where it was: the backend action asserts it, the
 * palette scope hides behind it, and this composable simply never runs when the
 * scope is unreachable.
 */
import { api } from '@owlat/api';

/** A citation the answer points at — a knowledge entry or an indexed file. */
export type QuickQuerySource =
	| { kind: 'knowledge'; id: string; title: string; entryType: string }
	| { kind: 'file'; id: string; title: string; filename: string };

export interface QuickQueryAnswer {
	answer: string;
	sources: QuickQuerySource[];
}

export function useCommandPaletteAsk() {
	const { t } = useI18n();
	const { run, isLoading } = useBackendOperation(api.quickQuery.ask, {
		label: () => t('components.query.quickQueryPanel.askOperation'),
		type: 'action',
	});

	const answer = ref<QuickQueryAnswer | null>(null);
	/** The question the on-screen answer belongs to, so a stale one is visible. */
	const askedQuestion = ref('');

	async function ask(question: string) {
		const trimmed = question.trim();
		if (!trimmed || isLoading.value) return;
		answer.value = null;
		askedQuestion.value = trimmed;
		const response = await run({ question: trimmed });
		if (!response?.ok) return;
		answer.value = (response.result as QuickQueryAnswer | undefined) ?? null;
	}

	function reset() {
		answer.value = null;
		askedQuestion.value = '';
	}

	return { ask, reset, answer, askedQuestion, isLoading };
}
