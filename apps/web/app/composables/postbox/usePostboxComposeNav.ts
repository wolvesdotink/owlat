/**
 * Opens the full-page composer (`/dashboard/compose`) for a new message, a
 * reopened draft, a forward as new mail or a resend. It replaced the floating
 * popup stack: one composer with the whole content area, the same editor Answer
 * mode writes replies in.
 *
 * The URL carries the state wherever it can: a saved draft opens as
 * `?draft=<id>`. A seed that only exists in memory (prefilled recipients, a
 * quoted body, the attachments an undo hands back) is parked in session state
 * under `?seed=<key>`; the composer's first autosave then writes the draft id
 * into the URL, so a reload lands on the same draft.
 */
import type { ComposerSeed } from './usePostboxCompose';

/** A composer seed plus, on a plain reply, the extras Reply-All would add. */
export type ComposeSpec = ComposerSeed & { replyAllRecipients?: string[] };

const COMPOSE_PATH = '/dashboard/compose';

/** True when `spec` names a saved draft and nothing else to prefill. */
function isDraftOnly(spec: ComposeSpec): boolean {
	const { mailboxId: _mailboxId, draftId, ...rest } = spec;
	return !!draftId && Object.values(rest).every((value) => value === undefined);
}

export function usePostboxComposeNav() {
	const seeds = useState<Record<string, ComposeSpec>>('postbox:compose-seeds', () => ({}));

	function open(spec: ComposeSpec) {
		if (isDraftOnly(spec)) {
			return navigateTo({
				path: COMPOSE_PATH,
				query: { mailbox: spec.mailboxId, draft: spec.draftId },
			});
		}
		const key = Math.random().toString(36).slice(2, 10);
		seeds.value = { ...seeds.value, [key]: spec };
		return navigateTo({ path: COMPOSE_PATH, query: { seed: key } });
	}

	/** The seed `open` parked under `key`, or null after a reload. */
	function seedFor(key: string): ComposeSpec | null {
		return seeds.value[key] ?? null;
	}

	return { open, seedFor };
}
