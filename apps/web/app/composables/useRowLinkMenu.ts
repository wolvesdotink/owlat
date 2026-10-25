import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';
import { useToast } from '@owlat/ui/composables/useToast';
import { getActiveWorkspace, isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import { useCopyToClipboard } from '~/composables/useCopyToClipboard';

/**
 * The verbs every linked row's context menu ends with: open the row in a new
 * tab and copy its link.
 *
 * A row menu replaces the browser's own menu, and on a link that one carried
 * exactly these two. Without them a right-click would take away what it used
 * to offer. The desktop app has no tabs, so it gets the copy only.
 *
 * A copied link is for someone else, or for a browser, to open. The desktop
 * webview's own origin (`tauri.localhost`) resolves nowhere outside the app,
 * so there the link is built on the connected instance's web origin.
 */
export function useRowLinkMenu() {
	const { t } = useI18n();
	const { copy } = useCopyToClipboard();
	const { showToast } = useToast();

	/** The origin a shareable link lives on; null on a desktop with no instance. */
	function linkOrigin(): string | null {
		if (!isDesktopRuntime()) return window.location.origin;
		return getActiveWorkspace()?.siteUrl || null;
	}

	// App paths are rooted at the origin: the app has no base URL and no hash
	// routing, so the row's own `to` is already the path a new tab needs.
	function absolute(to: string, origin: string): string {
		return new URL(to, origin).href;
	}

	async function copyLink(to: string, origin: string) {
		const ok = await copy(absolute(to, origin));
		if (ok) showToast(t('shared.rowMenu.linkCopied'));
		else showToast(t('shared.rowMenu.copyFailed'), 'error');
	}

	/** The link verbs for `to`, the first one drawing the group's divider. */
	function linkItems(to: string): ContextMenuItem[] {
		const origin = linkOrigin();
		if (origin === null) return [];
		const items: ContextMenuItem[] = [];
		if (!isDesktopRuntime()) {
			items.push({
				id: 'open-new-tab',
				label: t('shared.rowMenu.openInNewTab'),
				icon: 'lucide:external-link',
				run: () => void window.open(absolute(to, origin), '_blank', 'noopener'),
			});
		}
		items.push({
			id: 'copy-link',
			label: t('shared.rowMenu.copyLink'),
			icon: 'lucide:link',
			run: () => void copyLink(to, origin),
		});
		items[0]!.separatorBefore = true;
		return items;
	}

	/** "Open" for a row that is a link, ahead of the row's own verbs. */
	function openItem(to: string, shortcut?: string | null): ContextMenuItem {
		return {
			id: 'open',
			label: t('shared.rowMenu.open'),
			icon: 'lucide:arrow-right',
			...(shortcut ? { shortcut } : {}),
			run: () => void navigateTo(to),
		};
	}

	return { linkItems, openItem };
}
