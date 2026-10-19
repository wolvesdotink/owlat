const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** The controls under `root` that Tab stops at, in document order. */
export function tabbableIn(root: ParentNode): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(el) =>
			!el.closest('[hidden], [inert], [aria-hidden="true"]') &&
			(el.tabIndex >= 0 || el.getAttribute('contenteditable') === 'true')
	);
}
