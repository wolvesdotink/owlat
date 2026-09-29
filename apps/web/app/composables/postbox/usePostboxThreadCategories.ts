/**
 * Smart-inbox category grouping for the inbox view. Reuses the same
 * mail.mailbox.queries.listThreads feed as the conversation view (usePostboxThreadGroups)
 * and buckets each thread by its advisory `category.label`, then exposes the
 * ordered sections (People first), per-section collapsed state remembered across
 * navigations, and the "Recategorize as…" override mutation.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { MAIL_CATEGORY_META, type MailCategory } from '~/utils/mailCategory';
import { usePostboxThreadGroups } from './usePostboxThreadGroups';

/**
 * Section order (People first, "Everything else" last); icon and label KEY come
 * from the one category registry, and the list that renders a section resolves
 * the key with `t()`.
 *
 * `spam` has no section: the classifier files it into the Spam folder, and a
 * thread the owner brings back is recategorized to something else.
 */
const CATEGORY_SECTION_ORDER = [
	'person',
	'newsletter',
	'notification',
	'receipt',
	'promotion',
	'other',
] as const satisfies readonly MailCategory[];

const CATEGORY_SECTIONS: ReadonlyArray<{ key: MailCategory; label: string; icon: string }> =
	CATEGORY_SECTION_ORDER.map((key) => ({
		key,
		label: MAIL_CATEGORY_META[key].labelKey,
		icon: MAIL_CATEGORY_META[key].icon,
	}));

/**
 * Categories offered in the "Recategorize as…" picker (excludes ambiguity).
 * `label` is a message key, resolved by the picker (see {@link CATEGORY_SECTIONS}).
 */
export const RECATEGORIZE_OPTIONS: ReadonlyArray<{ key: MailCategory; label: string }> = [
	{ key: 'person', label: 'shared.postbox.usePostboxThreadCategories.options.person' },
	{ key: 'newsletter', label: 'shared.postbox.usePostboxThreadCategories.options.newsletter' },
	{ key: 'notification', label: 'shared.postbox.usePostboxThreadCategories.options.notification' },
	{ key: 'receipt', label: 'shared.postbox.usePostboxThreadCategories.options.receipt' },
	{ key: 'promotion', label: 'shared.postbox.usePostboxThreadCategories.options.promotion' },
	{ key: 'other', label: 'shared.postbox.usePostboxThreadCategories.options.other' },
	// Last and set apart: "Mark as spam" moves the thread to the Spam folder and
	// remembers the sender. Any other pick on a spam thread is "Not spam".
	{ key: 'spam', label: 'shared.postbox.usePostboxThreadCategories.options.spam' },
];

export function usePostboxThreadCategories(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	enabled: Ref<boolean>;
}) {
	const { t } = useI18n();
	// The same listThreads feed as the conversation view, on its own growable
	// limit so paging one view does not grow the other.
	const { threads, isLoading, hasMore, loadMore } = usePostboxThreadGroups({
		...args,
		limitKey: computed(() => `category:${args.folderRole.value}`),
	});

	// Unlabeled threads (backfill not yet run, or classification in flight) fall
	// into "Everything else" so nothing is ever hidden.
	const sections = computed(() =>
		CATEGORY_SECTIONS.map((section) => ({
			...section,
			threads: threads.value.filter((t) => (t.category?.label ?? 'other') === section.key),
		})).filter((section) => section.threads.length > 0)
	);

	// Collapsed state per category, remembered across navigations for the session.
	const collapsed = useState<Record<string, boolean>>('postbox:category-collapsed', () => ({}));
	function toggle(key: MailCategory) {
		collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
	}

	const recategorizeOp = useBackendOperation(api.mail.category.recategorize, {
		label: () => t('shared.postbox.usePostboxThreadCategories.recategorizeThread'),
	});
	async function recategorize(threadId: Id<'mailThreads'>, label: MailCategory) {
		await recategorizeOp.run({ threadId, label });
	}

	return { sections, isLoading, hasMore, loadMore, collapsed, toggle, recategorize };
}
