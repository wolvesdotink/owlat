/**
 * The shell's ambient signals: the unread badge and the notices that reach a
 * person wherever they are in the dashboard. Called once, by the dashboard
 * layout, so every signal below is wired exactly once per session.
 */
export function useShellNotices() {
	// Unread mail is read once and badged everywhere from the same count: the
	// browser tab (title prefix + dotted favicon) and, in the desktop app, the
	// dock/taskbar icon plus native notifications. The desktop app has no tab and
	// paints the count natively, so the tab badge stays browser-only.
	const unreadBadge = useUnreadBadge();
	const { isDesktop: isDesktopApp } = useDesktopContext();
	useTabBadge(() => (isDesktopApp.value ? null : unreadBadge.count.value));
	useDesktopNotifications(unreadBadge);
	// The tray icon's count and newest unread messages, from the same peek.
	useDesktopTray(unreadBadge);
	// The opt-in alert chimes (armed replies, assignments, agent questions) read
	// the same unread peek, in the browser and the desktop app alike.
	useAlertSounds(unreadBadge);

	// Campaign, delivery, automation and sending-domain notices: in-app toast
	// everywhere, native notification on the desktop app.
	useMarketingNotices();

	// "You can send now" — one in-app toast for a member whose onboarding first-send
	// step was blocked while the instance had no outbound transport.
	useSendReadyNotice();
}
