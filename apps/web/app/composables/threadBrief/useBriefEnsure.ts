/**
 * First-open interpretation (ADR-0072, D5): a thread whose brief reads
 * `completeness: 'none'`, or whose earlier history stopped being read
 * (`history: 'stalled'`, the spend gate or AI off), is handed to
 * `mail.interpret.lazy.ensure`, while the surface shows the conversation.
 * Shared by the personal brief (useThreadBrief) and the team surfaces
 * (useTeamOpenItems).
 *
 * A thread is remembered for the tab only once its history is read through
 * (`has_brief`, `nothing_to_read`); an accepted request is not, so a history
 * that stalls again is asked again. Every thread gets at most
 * {@link ENSURE_MAX_TRIES} asks per tab; a refusal (AI off, budget, rate
 * limit, a failed call) is retried after a growing pause, and AI turning on
 * later asks again.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type ThreadRefArg =
	| { kind: 'mail'; id: Id<'mailThreads'> }
	| { kind: 'team'; id: Id<'conversationThreads'> };

/** Asks per thread and tab, and the first pause before retrying a refusal. */
export const ENSURE_MAX_TRIES = 5;
export const ENSURE_RETRY_MS = 30_000;

/** Threads read through, and asks per thread, for this tab. */
const taken = new Set<string>();
const refusals = new Map<string, number>();

/** For tests: forget what this tab asked. */
export function resetBriefEnsure() {
	taken.clear();
	refusals.clear();
}

/** Answers that mean there is nothing left to ask for. */
const DONE_REASONS: ReadonlySet<string> = new Set(['has_brief', 'nothing_to_read']);
/** Answers that mean the server took it: no retry, but asked again if it stalls later. */
const ACCEPTED_REASONS: ReadonlySet<string> = new Set(['running']);

export function useBriefEnsure(opts: {
	threadRef: () => ThreadRefArg | null;
	completeness: () => string | undefined;
	/** The view's history progress (`brief.get` `history`). */
	history?: () => 'running' | 'stalled' | undefined;
}) {
	const { t } = useI18n();
	const { isEnabled } = useFeatureFlag();
	const ensureOp = useBackendOperation(api.mail.interpret.lazy.ensure, {
		label: () => t('components.brief.operations.ensure'),
		announce: false,
	});
	const inFlight = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	onScopeDispose(() => clearTimeout(timer));

	async function ask(ref: ThreadRefArg, key: string) {
		inFlight.add(key);
		const res = await ensureOp.run({ threadRef: ref });
		inFlight.delete(key);
		const result = res.ok ? (res.result as { isEnqueued: boolean; reason?: string }) : null;
		const tries = (refusals.get(key) ?? 0) + 1;
		refusals.set(key, tries);
		if (result && DONE_REASONS.has(result.reason ?? '')) {
			taken.add(key);
			return;
		}
		if (result && (result.isEnqueued || ACCEPTED_REASONS.has(result.reason ?? ''))) return;
		if (tries < ENSURE_MAX_TRIES) {
			clearTimeout(timer);
			timer = setTimeout(() => check(), ENSURE_RETRY_MS * tries);
		}
	}

	function check() {
		const ref = opts.threadRef();
		const wants = opts.completeness() === 'none' || opts.history?.() === 'stalled';
		if (!ref || !wants || !isEnabled('ai')) return;
		const key = `${ref.kind}:${ref.id}`;
		if (taken.has(key) || inFlight.has(key)) return;
		if ((refusals.get(key) ?? 0) >= ENSURE_MAX_TRIES) return;
		void ask(ref, key);
	}

	watch(
		() => [opts.threadRef(), opts.completeness(), isEnabled('ai'), opts.history?.()] as const,
		(now, before) => {
			// AI just turned on: what it refused before is asked again.
			if (now[2] && before && !before[2]) refusals.clear();
			check();
		},
		{ immediate: true }
	);
}
