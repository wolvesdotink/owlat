/**
 * Mail scope for the command palette: the operator grammar, its autocomplete,
 * and live hits from the real mail search.
 *
 * This is what the Postbox rail's search bar used to be. The grammar itself is
 * unchanged — the same `~/utils/postboxSearchQuery` parser reaching the same
 * `mail.mailbox.search.search` query, and the same `~/utils/postboxSearchSuggest`
 * ranking for the token under the caret — it just renders as palette rows now
 * instead of a second input with its own dropdown.
 *
 * Every subscription here is gated on `enabled` AND on a resolved mailbox: the
 * palette is mounted on EVERY dashboard page, so a Mail-scope query must cost
 * nothing on the billing screen. Without a mailbox the scope still works — the
 * grammar completes, and Enter still reaches the deep search page.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PaletteItem } from '~/lib/commandPalette';
import { SEARCH_MIN_QUERY } from '~/lib/commandPaletteCore';
import { parseSearchQuery } from '~/utils/postboxSearchQuery';
import {
	activeSearchToken,
	applySearchSuggestion,
	buildSearchSuggestions,
} from '~/utils/postboxSearchSuggest';

/** How many live hits the overlay shows before the "all results" row. */
const MAIL_SCOPE_HIT_LIMIT = 5;

/** Mirrors `usePostboxSearch`: how still the box has to be before we subscribe. */
const MAIL_SEARCH_DEBOUNCE_MS = 250;

/** Debounce on the address book, so a held key doesn't reopen it per character. */
const CONTACT_DEBOUNCE_MS = 200;

/** Operators whose operand the address book completes. */
const ADDRESS_OPERATORS = ['from', 'to', 'cc', 'bcc'];

export interface CommandPaletteMailScopeOptions {
	/** The mail query, with any palette mode prefix already stripped. */
	query: Ref<string>;
	/** Caret offset inside `query` — completions are token-aware, not box-aware. */
	caret: Ref<number>;
	/** False whenever the overlay is not in Mail scope: nothing subscribes. */
	enabled: Ref<boolean>;
	/** Rewrite the box after a completion and put the caret where it belongs. */
	onReplace: (value: string, caret: number) => void;
	/** Remember the query that opened a hit (scope-tagged palette recents). */
	onRemember: (term: string) => void;
}

export function useCommandPaletteMailScope(options: CommandPaletteMailScopeOptions) {
	const { t } = useI18n();
	const { activeMailboxId, setActiveMailboxId } = usePostboxActiveMailbox();

	// ── The token under the caret, and the operand it opens ────────────────────
	const token = computed(() =>
		options.enabled.value
			? activeSearchToken(options.query.value, options.caret.value)
			: { start: 0, end: 0, text: '' }
	);
	const operand = computed(() => {
		const body = token.value.text.replace(/^-/, '');
		const colon = body.indexOf(':');
		if (colon <= 0) return null;
		return {
			op: body.slice(0, colon).toLowerCase(),
			value: body.slice(colon + 1).replace(/^"|"$/g, ''),
		};
	});

	// ── Data-backed operands. Both reads are per-operator: the address book only
	// opens while an address operator is being typed, the labels only for `label:`.
	const { query: contactPrefix, debouncedQuery: debouncedContactPrefix } =
		useDebouncedSearch(CONTACT_DEBOUNCE_MS);
	watch(operand, (current) => {
		contactPrefix.value = current && ADDRESS_OPERATORS.includes(current.op) ? current.value : '';
	});

	const { data: contactData } = useConvexQuery(api.mail.contacts.autocomplete, () =>
		options.enabled.value && activeMailboxId.value && debouncedContactPrefix.value
			? { mailboxId: activeMailboxId.value, prefix: debouncedContactPrefix.value, limit: 6 }
			: 'skip'
	);
	const contacts = computed(() =>
		(contactData.value ?? []).map((contact) => ({
			email: contact.email,
			displayName: contact.displayName ?? undefined,
		}))
	);

	const { data: labelData } = useConvexQuery(api.mail.labels.list, () =>
		options.enabled.value && activeMailboxId.value && operand.value?.op === 'label'
			? { mailboxId: activeMailboxId.value }
			: 'skip'
	);
	const labels = computed(() => labelData.value ?? []);

	/**
	 * Completion rows. History is deliberately NOT passed: recents are their own
	 * palette group (`core:recent`), scope-tagged and shared with every scope, so
	 * offering them twice would be the duplication this whole change removes.
	 */
	const suggestionItems = computed<PaletteItem[]>(() => {
		if (!options.enabled.value) return [];
		return buildSearchSuggestions({
			token: token.value.text,
			boxEmpty: options.query.value.trim().length === 0,
			contacts: contacts.value,
			labels: labels.value,
			limit: 6,
		}).map((suggestion) => ({
			id: `mail-suggest:${suggestion.id}`,
			label: suggestion.label,
			subtitle: suggestion.hint
				? t(suggestion.hint.key, suggestion.hint.params ?? {})
				: suggestion.detail,
			icon: suggestion.icon,
			// A completion refines the query — it never leaves the overlay.
			keepOpen: true,
			run: () => {
				const next = applySearchSuggestion(options.query.value, token.value, suggestion.insert);
				// An operator that opens an operand (`from:`) keeps the caret on its
				// value; a complete term (`is:unread`) gets a trailing space so the
				// next term starts clean.
				options.onReplace(
					suggestion.isTerminal ? `${next.value} ` : next.value,
					suggestion.isTerminal ? next.caret + 1 : next.caret
				);
			},
		}));
	});

	// ── Live hits from the deep search, off a debounced mirror of the box.
	const {
		query: pendingQuery,
		debouncedQuery,
		setImmediate,
	} = useDebouncedSearch(MAIL_SEARCH_DEBOUNCE_MS);
	watch(options.query, (value) => {
		pendingQuery.value = value;
	});
	/** Drop the previous query's hits the moment the scope closes or reopens. */
	function resetQuery(value = '') {
		setImmediate(value);
	}

	const parsed = computed(() => parseSearchQuery(debouncedQuery.value));
	const isSubscribed = computed(
		() =>
			options.enabled.value &&
			activeMailboxId.value !== null &&
			debouncedQuery.value.trim().length >= SEARCH_MIN_QUERY
	);
	const { data: searchData } = useConvexQuery(api.mail.mailbox.search.search, () =>
		isSubscribed.value
			? {
					mailboxId: activeMailboxId.value as Id<'mailboxes'>,
					...parsed.value,
					limit: MAIL_SCOPE_HIT_LIMIT,
				}
			: 'skip'
	);

	/** True while the box is ahead of the subscription, or the page is in flight. */
	const isSearching = computed(
		() =>
			options.enabled.value &&
			activeMailboxId.value !== null &&
			options.query.value.trim().length >= SEARCH_MIN_QUERY &&
			(options.query.value !== debouncedQuery.value || searchData.value === undefined)
	);

	const hitItems = computed<PaletteItem[]>(() =>
		(searchData.value?.messages ?? []).map((message) => ({
			id: `mail-hit:${message._id}`,
			label: message.subject?.trim() || t('components.appCommandPalette.noSubject'),
			subtitle: `${message.fromName || message.fromAddress} · ${message.snippet}`.trim(),
			icon: 'lucide:mail',
			run: () => {
				options.onRemember(options.query.value);
				// A hit may live in another mailbox (a team inbox); point the Postbox
				// selection at it first or the thread opens as "not found".
				if (message.mailboxId) setActiveMailboxId(message.mailboxId);
				// The Postbox route takes a system-folder role OR a folder id, and the
				// message document carries the id — no folder read needed.
				void navigateTo(`/dashboard/postbox/${message.folderId}/${message._id}`);
			},
		}))
	);

	return { suggestionItems, hitItems, isSearching, resetQuery };
}
