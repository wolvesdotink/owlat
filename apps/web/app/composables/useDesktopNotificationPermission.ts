import {
	desktopPlatformFrom,
	osNotificationSettingsUri,
	type DesktopPlatform,
} from '~/lib/desktop/notificationPermission';
import type { DesktopNotificationPermission } from '@owlat/desktop/src/notifications';

/**
 * OS notification permission for the desktop app.
 *
 * The app used to call `.show()` straight from Rust without ever asking, so on
 * macOS and Windows the very first toast could silently vanish. This owns the
 * missing half: a permission we CHECK before sending, REQUEST once at startup,
 * can re-request from the settings panel, and can prove with a test
 * notification.
 *
 * The value is shared app-wide (`useState`) so the notification pipeline and
 * the settings panel never disagree about it. `unavailable` — the browser, or a
 * plugin call that threw — is deliberately NOT a block: the send path still
 * tries, exactly as it did before this check existed.
 */
export function useDesktopNotificationPermission() {
	const { isDesktop } = useDesktopContext();
	const permission = useState<DesktopNotificationPermission>(
		'desktop-notification-permission',
		() => 'unavailable'
	);
	const isBusy = useState<boolean>('desktop-notification-permission-busy', () => false);

	/** Sending is blocked only by an explicit refusal; everything else tries. */
	const canSend = computed(() => permission.value !== 'denied');
	const isDenied = computed(() => permission.value === 'denied');

	const platform = computed<DesktopPlatform>(() =>
		typeof navigator === 'undefined' ? 'linux' : desktopPlatformFrom(navigator.platform)
	);
	/** Null on Linux, where the pane differs per desktop environment. */
	const osSettingsUri = computed(() => osNotificationSettingsUri(platform.value));

	function loadBridge() {
		return import('@owlat/desktop/src/notifications');
	}

	/** Read the current permission without prompting. */
	async function refresh(): Promise<DesktopNotificationPermission> {
		if (!isDesktop.value) return permission.value;
		try {
			const { checkNotificationPermission } = await loadBridge();
			permission.value = await checkNotificationPermission();
		} catch {
			permission.value = 'unavailable';
		}
		return permission.value;
	}

	/**
	 * Ask the OS, prompting when the permission has never been decided. Safe to
	 * call on every mount: an already-granted or already-refused permission is
	 * answered from the plugin without a second prompt.
	 */
	async function request(): Promise<DesktopNotificationPermission> {
		if (!isDesktop.value) return permission.value;
		isBusy.value = true;
		try {
			const { requestNotificationPermission } = await loadBridge();
			permission.value = await requestNotificationPermission();
		} catch {
			permission.value = 'unavailable';
		} finally {
			isBusy.value = false;
		}
		return permission.value;
	}

	/**
	 * Fire one notification the user asked for, so "granted" is something they
	 * can see rather than a claim. Requests permission first when it is still
	 * undecided; reports whether the notification was actually attempted.
	 */
	async function sendTest(title: string, body: string): Promise<boolean> {
		if (!isDesktop.value) return false;
		const state = permission.value === 'granted' ? permission.value : await request();
		if (state === 'denied') return false;
		try {
			const { sendDesktopNotification } = await loadBridge();
			await sendDesktopNotification(title, body);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Open the OS notification settings pane — the only route back from a
	 * refusal. False when the platform has no single pane to link (Linux) or the
	 * shell bridge is unavailable, so the caller can fall back to instructions.
	 */
	async function openOsSettings(): Promise<boolean> {
		const uri = osSettingsUri.value;
		if (!uri || !isDesktop.value) return false;
		try {
			const { openExternal } = await import('@owlat/desktop/src/shell');
			await openExternal(uri);
			return true;
		} catch {
			return false;
		}
	}

	return {
		permission,
		isBusy,
		canSend,
		isDenied,
		osSettingsUri,
		refresh,
		request,
		sendTest,
		openOsSettings,
	};
}
