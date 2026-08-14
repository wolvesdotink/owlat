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

/**
 * Section order + presentation (People first, "Everything else" last).
 *
 * A module-scope registry, so `label` carries a message KEY rather than the
 * sentence itself (the i18n registry convention); the list that renders it
 * resolves the key with `t()`.
 */
export const CATEGORY_SECTIONS: ReadonlyArray<{
	key: MailCategory;
	label: string;
	icon: string;
}> = [
	{
		key: 'person',
		label: 'shared.postbox.usePostboxThreadCategories.sections.person',
		icon: 'lucide:user',
	},
	{
		key: 'newsletter',
		label: 'shared.postbox.usePostboxThreadCategories.sections.newsletter',
		icon: 'lucide:newspaper',
	},
	{
		key: 'notification',
		label: 'shared.postbox.usePostboxThreadCategories.sections.notification',
		icon: 'lucide:bell',
	},
	{
		key: 'receipt',
		label: 'shared.postbox.usePostboxThreadCategories.sections.receipt',
		icon: 'lucide:receipt',
	},
	{
		key: 'other',
		label: 'shared.postbox.usePostboxThreadCategories.sections.other',
		icon: 'lucide:inbox',
	},
];

/**
 * Categories offered in the "Recategorize as…" picker (excludes ambiguity).
 * `label` is a message key, resolved by the picker (see {@link CATEGORY_SECTIONS}).
 */
export const RECATEGORIZE_OPTIONS: ReadonlyArray<{ key: MailCategory; label: string }> = [
	{ key: 'person', label: 'shared.postbox.usePostboxThreadCategories.options.person' },
	{ key: 'newsletter', label: 'shared.postbox.usePostboxThreadCategories.options.newsletter' },
	{ key: 'notification', label: 'shared.postbox.usePostboxThreadCategories.options.notification' },
	{ key: 'receipt', label: 'shared.postbox.usePostboxThreadCategories.options.receipt' },
	{ key: 'other', label: 'shared.postbox.usePostboxThreadCategories.options.other' },
];

export function usePostboxThreadCategories(args: {
	mailboxId: Ref<Id<'mailboxes'> | null>;
	folderRole: Ref<string>;
	enabled: Ref<boolean>;
}) {
	const { t } = useI18n();
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
		label: () => t('shared.postbox.usePostboxThreadCategories.recategorizeThread'),
	});
	async function recategorize(threadId: Id<'mailThreads'>, label: MailCategory) {
		await recategorizeOp.run({ threadId, label });
	}

	return { sections, isLoading, hasMore, loadMore, collapsed, toggle, recategorize };
}
