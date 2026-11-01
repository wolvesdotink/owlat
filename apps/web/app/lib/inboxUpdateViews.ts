import {
	BellIcon,
	MegaphoneIcon,
	NotebookIcon,
	ShieldOffIcon,
	type IconComponent,
} from '@coolicons/vue';

/** The Updates page's tabs, one per kind of mail that needs no reply. */
export type UpdateView = 'updates' | 'promotions' | 'notifications' | 'spam';

/** The tabs in display order; the first is the page's default view. */
export const UPDATE_VIEWS: ReadonlyArray<{ key: UpdateView; icon: IconComponent }> = [
	{ key: 'updates', icon: NotebookIcon },
	{ key: 'promotions', icon: MegaphoneIcon },
	{ key: 'notifications', icon: BellIcon },
	{ key: 'spam', icon: ShieldOffIcon },
];
