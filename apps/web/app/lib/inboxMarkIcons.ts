import { BriefcaseIcon, HouseIcon, StoreIcon, UsersIcon } from '@coolicons/vue';
import type { InboxMarkIcon } from '~/utils/inboxIdentity';

/** The glyph each inbox mark icon draws. */
export const INBOX_MARK_ICON_COMPONENTS: Record<InboxMarkIcon, typeof HouseIcon> = {
	home: HouseIcon,
	work: BriefcaseIcon,
	team: UsersIcon,
	shop: StoreIcon,
};
