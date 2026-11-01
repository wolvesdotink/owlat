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
import {
	BellIcon,
	InboxIcon,
	MegaphoneIcon,
	NotebookIcon,
	ReceiptIcon,
	ShieldOffIcon,
	UserIcon,
	type IconComponent,
} from '@coolicons/vue';

export type MailCategory = NonNullable<Doc<'mailThreads'>['category']>['label'];

export const MAIL_CATEGORY_META: Readonly<
	Record<MailCategory, { icon: IconComponent; labelKey: string }>
> = {
	person: { icon: UserIcon, labelKey: 'shared.mailCategory.person' },
	newsletter: { icon: NotebookIcon, labelKey: 'shared.mailCategory.newsletter' },
	notification: { icon: BellIcon, labelKey: 'shared.mailCategory.notification' },
	receipt: { icon: ReceiptIcon, labelKey: 'shared.mailCategory.receipt' },
	// Megaphone, not tag: the tag is the Recategorize button's icon.
	promotion: { icon: MegaphoneIcon, labelKey: 'shared.mailCategory.promotion' },
	spam: { icon: ShieldOffIcon, labelKey: 'shared.mailCategory.spam' },
	other: { icon: InboxIcon, labelKey: 'shared.mailCategory.other' },
};
