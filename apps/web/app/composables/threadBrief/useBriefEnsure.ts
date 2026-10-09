/**
 * First-open interpretation (ADR-0072, D5): a thread whose brief reads
 * `completeness: 'none'` is handed to `mail.interpret.lazy.ensure`, while the
 * surface shows the conversation. Shared by the personal brief
 * (useThreadBrief) and the team surfaces (useTeamOpenItems).
 *
 * A thread is remembered for the tab only once the server took it (queued,
 * already running, already read, or nothing to read). A refusal (AI off,
 * budget, rate limit, a failed call) is retried a few times with a growing
 * pause, and AI turning on later asks again.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type ThreadRefArg =
	| { kind: 'mail'; id: Id<'mailThreads'> }
	| { kind: 'team'; id: Id<'conversationThreads'> };

/** Asks per thread after a refusal, and the first pause between them. */
export const ENSURE_MAX_TRIES = 3;
export const ENSURE_RETRY_MS = 30_000;

/** Threads the server took, and refused tries per thread, for this tab. */
const taken = new Set<string>();
const refusals = new Map<string, number>();

/** For tests: forget what this tab asked. */
export function resetBriefEnsure() {
	taken.clear();
	refusals.clear();
}

const TAKEN_REASONS: ReadonlySet<string> = new Set(['has_brief', 'running', 'nothing_to_read']);

export function useBriefEnsure(opts: {
	threadRef: () => ThreadRefArg | null;
	completeness: () => string | undefined;
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
		if (result && (result.isEnqueued || TAKEN_REASONS.has(result.reason ?? ''))) {
			taken.add(key);
			return;
		}
		const tries = (refusals.get(key) ?? 0) + 1;
		refusals.set(key, tries);
		if (tries < ENSURE_MAX_TRIES) {
			clearTimeout(timer);
			timer = setTimeout(() => check(), ENSURE_RETRY_MS * tries);
		}
	}

	function check() {
		const ref = opts.threadRef();
		if (!ref || opts.completeness() !== 'none' || !isEnabled('ai')) return;
		const key = `${ref.kind}:${ref.id}`;
		if (taken.has(key) || inFlight.has(key)) return;
		if ((refusals.get(key) ?? 0) >= ENSURE_MAX_TRIES) return;
		void ask(ref, key);
	}

	watch(
		() => [opts.threadRef(), opts.completeness(), isEnabled('ai')] as const,
		(now, before) => {
			// AI just turned on: what it refused before is asked again.
			if (now[2] && before && !before[2]) refusals.clear();
			check();
		},
		{ immediate: true }
	);
}
