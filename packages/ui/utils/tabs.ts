/**
 * The contract between a UiTabs strip and the panel its caller renders.
 *
 * UiTabs only draws the tabs; the content under them belongs to the caller,
 * which usually renders just the selected tab's content in one region. So the
 * caller owns one panel id and hands it to both sides: `:panel-id` on UiTabs
 * (the selected tab then points `aria-controls` at it) and `tabPanelAttrs` on
 * the region (which labels it by the selected tab). Without a panel id UiTabs
 * emits no `aria-controls` at all, so nothing ever points at a missing element.
 */

export interface UiTabOption {
	value: string;
	label: string;
	count?: number;
}

/**
 * The tab that counts as selected: the one matching `modelValue`, else the
 * first. UiTabs uses this for both its markup and its arrow keys, so exactly one
 * tab is tabbable even before the caller has picked a value.
 */
export function selectedTabValue(
	tabs: readonly UiTabOption[],
	modelValue: string | undefined
): string | undefined {
	return tabs.find((tab) => tab.value === modelValue)?.value ?? tabs[0]?.value;
}

/**
 * The DOM id of the tab for `value` in the strip bound to `panelId`. Anything
 * outside `[A-Za-z0-9-]` is hex-escaped, so a value can neither split the id
 * into two IDREFs nor collide with another value's id.
 */
export function tabElementId(panelId: string, value: string): string {
	const safe = value.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`);
	return `${panelId}-tab-${safe}`;
}

/** Attributes for the caller's panel region: `v-bind="tabPanelAttrs(...)"`. */
export function tabPanelAttrs(
	panelId: string,
	tabs: readonly UiTabOption[],
	modelValue: string | undefined
): { id: string; role: 'tabpanel'; 'aria-labelledby'?: string } {
	const selected = selectedTabValue(tabs, modelValue);
	return {
		id: panelId,
		role: 'tabpanel',
		...(selected === undefined ? {} : { 'aria-labelledby': tabElementId(panelId, selected) }),
	};
}
