/**
 * The palette rows built from the cross-object search index (`globalSearch`):
 * contacts, campaigns, templates, mail snippets, and the "search all mail for…"
 * escape hatch under them.
 *
 * Extracted from `AppCommandPalette.vue` to keep that component under the
 * file-size cap. It is the injected half of the pure `buildCorePaletteProviders`
 * factory: the factory owns WHICH group these land in and in what order, this
 * owns what selecting one DOES.
 */
import type { Id } from '@owlat/api/dataModel';
import type { PaletteItem } from '~/lib/commandPalette';
import type { SearchResult } from '~/lib/commandPaletteCore';

export interface CommandPaletteObjectItemsOptions {
	/** Record a term in the active scope's recents before navigating away. */
	onRemember: (term: string) => void;
	/** Close the overlay — a row that navigates must not leave it hanging open. */
	onNavigate: () => void;
	/** The prefix-stripped query, remembered when a hit is opened. */
	term: () => string;
}

export function useCommandPaletteObjectItems(options: CommandPaletteObjectItemsOptions) {
	const { t } = useI18n();
	// Selecting a mail hit may cross mailboxes, so the active Postbox mailbox is
	// pointed at the message's own mailbox before navigating — otherwise the
	// thread opens against whichever mailbox happened to be selected and reads as
	// "not found". The state-only selection composable is deliberate: the palette
	// is mounted on every dashboard page and must not open Postbox subscriptions.
	const { setActiveMailboxId } = usePostboxActiveMailbox();

	function iconForType(type: string): string {
		if (type === 'contact') return 'lucide:user';
		if (type === 'campaign') return 'lucide:megaphone';
		return 'lucide:mail';
	}

	function buildResultItems(results: SearchResult[]): PaletteItem[] {
		return results.map((result) => ({
			id: `search:${result.id}`,
			label: result.title,
			subtitle: result.subtitle,
			icon: iconForType(result.type),
			run: () => {
				options.onRemember(options.term());
				void navigateTo(result.url);
			},
		}));
	}

	function buildMailItems(results: SearchResult[]): PaletteItem[] {
		return results.map((result) => ({
			id: `mail:${result.id}`,
			label: result.title.trim() || t('components.appCommandPalette.noSubject'),
			subtitle: result.subtitle,
			icon: 'lucide:mail',
			run: () => {
				options.onRemember(options.term());
				if (result.mailboxId) setActiveMailboxId(result.mailboxId as Id<'mailboxes'>);
				void navigateTo(result.url);
			},
		}));
	}

	/**
	 * The deep mail search — the full operator grammar, pagination and body index
	 * this palette will never have. It is both the row under the mail hits and
	 * what Enter does in Mail scope, so both paths land on the same page.
	 */
	function goToMailSearch(term: string) {
		options.onRemember(term);
		options.onNavigate();
		void navigateTo({ path: '/dashboard/postbox/search', query: { q: term } });
	}

	function buildSearchMailItem(term: string): PaletteItem {
		return {
			id: 'mail:search-for',
			label: t('components.appCommandPalette.searchMailFor', { query: term }),
			icon: 'lucide:search',
			hint: '↵',
			run: () => goToMailSearch(term),
		};
	}

	return { buildResultItems, buildMailItems, buildSearchMailItem, goToMailSearch };
}
