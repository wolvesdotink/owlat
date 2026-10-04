/**
 * Opens the full-page composer (`/dashboard/compose`) for a new message, a
 * reopened draft, a forward as new mail or a resend. It replaced the floating
 * popup stack: one composer with the whole content area, the same editor Answer
 * mode writes replies in.
 *
 * Every open is its own compose request, named by `?c=<key>`: the page is keyed
 * on it, so opening a second composition while one is on screen remounts the
 * editor instead of leaving the first one there under the new URL.
 *
 * A saved draft also travels in the URL (`&draft=<id>`). A seed that only exists
 * in memory (prefilled recipients, a quoted body, the text and attachments an
 * offline undo hands back) is parked under the request key, in session state
 * and in this tab's sessionStorage, so a reload before it reaches the server
 * keeps it. The page forgets it once the composer confirms the text is saved.
 */
import type { ComposerSeed } from './usePostboxCompose';

/** A composer seed plus, on a plain reply, the extras Reply-All would add. */
export type ComposeSpec = ComposerSeed & { replyAllRecipients?: string[] };

const COMPOSE_PATH = '/dashboard/compose';
const STORAGE_PREFIX = 'owlat:compose-seed:';

/**
 * The compose page's instance key: one per compose request (`?c=`), so a new
 * open remounts the editor while the page's own URL rewrite, which keeps `c`,
 * does not. Lives here because `definePageMeta` is hoisted out of the page.
 */
export function composePageKey(rawRequestKey: unknown): string {
	const value = Array.isArray(rawRequestKey) ? rawRequestKey[0] : rawRequestKey;
	return `compose:${typeof value === 'string' ? value : ''}`;
}

/** True when `spec` names a saved draft and nothing else to prefill. */
function isDraftOnly(spec: ComposeSpec): boolean {
	const { mailboxId: _mailboxId, draftId, ...rest } = spec;
	return !!draftId && Object.values(rest).every((value) => value === undefined);
}

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage;
	} catch {
		// Storage disabled (privacy mode): session state alone still covers
		// in-app navigation.
		return null;
	}
}

export function usePostboxComposeNav() {
	const seeds = useState<Record<string, ComposeSpec>>('postbox:compose-seeds', () => ({}));

	function open(spec: ComposeSpec) {
		const key = Math.random().toString(36).slice(2, 10);
		if (isDraftOnly(spec)) {
			return navigateTo({
				path: COMPOSE_PATH,
				query: { c: key, mailbox: spec.mailboxId, draft: spec.draftId },
			});
		}
		seeds.value = { ...seeds.value, [key]: spec };
		try {
			storage()?.setItem(STORAGE_PREFIX + key, JSON.stringify(spec));
		} catch {
			// Quota or serialization trouble: the in-memory copy still stands.
		}
		return navigateTo({ path: COMPOSE_PATH, query: { c: key } });
	}

	/** The seed `open` parked under `key`, or null once it was forgotten. */
	function seedFor(key: string): ComposeSpec | null {
		const parked = seeds.value[key];
		if (parked) return parked;
		const stored = storage()?.getItem(STORAGE_PREFIX + key);
		if (!stored) return null;
		try {
			return JSON.parse(stored) as ComposeSpec;
		} catch {
			return null;
		}
	}

	/** Drop a parked seed: the server holds everything it carried. */
	function forget(key: string) {
		if (key in seeds.value) {
			const { [key]: _dropped, ...rest } = seeds.value;
			seeds.value = rest;
		}
		storage()?.removeItem(STORAGE_PREFIX + key);
	}

	return { open, seedFor, forget };
}
