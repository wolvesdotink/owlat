/**
 * True while a dialog other than `except` is on screen. Every dialog the app
 * opens — modal or not, teleported to body or rendered inline — carries
 * `role="dialog"`, and each one owns the keyboard while it is up, so a
 * single-key shortcut handler asks this before acting on a keypress.
 */
export function isDialogOpen(except?: Element | null): boolean {
	return Array.from(document.querySelectorAll('[role="dialog"]')).some((el) => el !== except);
}
