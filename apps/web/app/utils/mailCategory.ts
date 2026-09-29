/**
 * The smart-inbox category vocabulary on the web: the label type, derived
 * from the `mailThreads.category` schema field (so a category added to
 * `mailCategoryLabelValidator` reaches every `Record<MailCategory, …>` here as
 * a compile error), and one icon + label per category.
 *
 * Every surface that names a category — the Categories view's section
 * headers, the Bundled view's bundle rows, Today's "Filed away" tiles — reads
 * its icon from here, so the same category never wears two icons. `labelKey`
 * is a catalog KEY (module scope never calls `useI18n`), the plural heading
 * form ("Newsletters"); a surface that needs a counted or singular noun keeps
 * its own message and still takes the icon from here.
 */
import type { Doc } from '@owlat/api/dataModel';

export type MailCategory = NonNullable<Doc<'mailThreads'>['category']>['label'];

export const MAIL_CATEGORY_META: Readonly<
	Record<MailCategory, { icon: string; labelKey: string }>
> = {
	person: { icon: 'lucide:user', labelKey: 'shared.mailCategory.person' },
	newsletter: { icon: 'lucide:newspaper', labelKey: 'shared.mailCategory.newsletter' },
	notification: { icon: 'lucide:bell', labelKey: 'shared.mailCategory.notification' },
	receipt: { icon: 'lucide:receipt', labelKey: 'shared.mailCategory.receipt' },
	// Megaphone, not tag: `lucide:tag` is the Recategorize button's icon.
	promotion: { icon: 'lucide:megaphone', labelKey: 'shared.mailCategory.promotion' },
	spam: { icon: 'lucide:shield-off', labelKey: 'shared.mailCategory.spam' },
	other: { icon: 'lucide:inbox', labelKey: 'shared.mailCategory.other' },
};
