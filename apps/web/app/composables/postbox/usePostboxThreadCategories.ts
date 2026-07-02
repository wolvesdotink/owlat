/**
 * Smart-inbox category grouping for the inbox view. Reuses the same
 * mail.mailbox.listThreads feed as the conversation view (usePostboxThreadGroups)
 * and buckets each thread by its advisory `category.label`, then exposes the
 * ordered sections (People first), per-section collapsed state remembered across
 * navigations, and the "Recategorize as…" override mutation.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export type MailCategory = 'person' | 'newsletter' | 'notification' | 'receipt' | 'other';

/** Section order + presentation (People first, "Everything else" last). */
export const CATEGORY_SECTIONS: ReadonlyArray<{
	key: MailCategory;
	label: string;
	icon: string;
}> = [
	{ key: 'person', label: 'People', icon: 'lucide:user' },
	{ key: 'newsletter', label: 'Newsletters', icon: 'lucide:newspaper' },
	{ key: 'notification', label: 'Notifications', icon: 'lucide:bell' },
	{ key: 'receipt', label: 'Receipts', icon: 'lucide:receipt' },
	{ key: 'other', label: 'Everything else', icon: 'lucide:inbox' },
];

/** Categories offered in the "Recategorize as…" picker (excludes ambiguity). */
export const RECATEGORIZE_OPTIONS: ReadonlyArray<{ key: MailCategory; label: string }> = [
	{ key: 'person', label: 'Person' },
	{ key: 'newsletter', label: 'Newsletter' },
	{ key: 'notification', label: 'Notification' },
	{ key: 'receipt', label: 'Receipt' },
	{ key: 'other', label: 'Other' },
];

export function usePostboxThreadCategories(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	enabled: Ref<boolean>;
}) {
	const { limit, loadMore, atMax } = useGrowableLimit(
		computed(() => `category:${args.folderRole.value}`)
	);

	const { data, isLoading } = useConvexQuery(
		api.mail.mailbox.listThreads,
		() =>
			args.enabled.value && args.mailboxId.value
				? {
						mailboxId: args.mailboxId.value,
						folderRole: args.folderRole.value,
						limit: limit.value,
					}
				: 'skip',
		{ keepPreviousData: true }
	);

	const threads = computed(() => data.value?.threads ?? []);
	const hasMore = computed(() => (data.value?.hasMore ?? false) && !atMax.value);

	// Unlabeled threads (backfill not yet run, or classification in flight) fall
	// into "Everything else" so nothing is ever hidden.
	const sections = computed(() =>
		CATEGORY_SECTIONS.map((section) => ({
			...section,
			threads: threads.value.filter(
				(t) => (t.category?.label ?? 'other') === section.key
			),
		})).filter((section) => section.threads.length > 0)
	);

	// Collapsed state per category, remembered across navigations for the session.
	const collapsed = useState<Record<string, boolean>>(
		'postbox:category-collapsed',
		() => ({})
	);
	function toggle(key: MailCategory) {
		collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] };
	}

	const recategorizeOp = useBackendOperation(api.mail.category.recategorize, {
		label: 'Recategorize thread',
	});
	async function recategorize(threadId: Id<'mailThreads'>, label: MailCategory) {
		await recategorizeOp.run({ threadId, label });
	}

	return { sections, isLoading, hasMore, loadMore, collapsed, toggle, recategorize };
}
