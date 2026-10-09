/**
 * First-open interpretation (ADR-0072, D5): a thread whose brief reads
 * `completeness: 'none'` is handed to `mail.interpret.lazy.ensure` once per
 * tab, while the surface shows the conversation. Shared by the personal brief
 * (useThreadBrief) and the team surfaces (useTeamOpenItems); the server is
 * idempotent too, so a second tab asking again changes nothing.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type ThreadRefArg =
	| { kind: 'mail'; id: Id<'mailThreads'> }
	| { kind: 'team'; id: Id<'conversationThreads'> };

/** Threads this tab already asked to interpret. */
const ensured = new Set<string>();

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
	watch(
		() => [opts.threadRef(), opts.completeness()] as const,
		([ref, completeness]) => {
			if (!ref || completeness !== 'none' || !isEnabled('ai')) return;
			const key = `${ref.kind}:${ref.id}`;
			if (ensured.has(key)) return;
			ensured.add(key);
			void ensureOp.run({ threadRef: ref });
		},
		{ immediate: true }
	);
}
