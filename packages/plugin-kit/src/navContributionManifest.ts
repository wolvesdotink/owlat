import { forEachContributionItem, validateContributionLocalId } from './contributionManifest';
import { isSafeInternalNavPath } from './internalPath';
import { addManifestIssue, type PluginManifestIssue } from './manifestIssues';
import { readDataProperty, type DataProperty } from './manifestValue';

/**
 * Shared field validation for the two frontend navigation contribution buckets
 * (`navItems`, `settingsPanels`). Both are labelled links: a stable local id, a
 * display name, a safe internal href, an icon token, and an optional ordering
 * hint. `navItems` additionally target a core section. Keeping the field checks
 * here means adding a navigation-shaped registry is one call, not another copy
 * of five identical checks.
 */

const SECTION_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ICON = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SECTION_KEY_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
/**
 * Control (`Cc`) and format (`Cf`) code points the render-side `clampLabel`
 * strips. A name made only of these survives `trim()` (which strips whitespace
 * only) but renders as an empty, unlabelled link, so validation must mirror the
 * clamp and require a name that is non-empty after they are removed.
 */
const CONTROL_OR_FORMAT = /\p{Cc}|\p{Cf}/gu;
const MAX_ORDER = 100_000;

const NAV_ITEM_FIELDS = new Set(['id', 'section', 'name', 'href', 'icon', 'order']);
const SETTINGS_PANEL_FIELDS = new Set(['id', 'name', 'href', 'icon', 'order']);

export function validateNavItemContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	validateNavigationContributions('navItems', NAV_ITEM_FIELDS, true, items, issues);
}

export function validateSettingsPanelContributions(
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	validateNavigationContributions('settingsPanels', SETTINGS_PANEL_FIELDS, false, items, issues);
}

function validateNavigationContributions(
	bucket: string,
	fields: ReadonlySet<string>,
	requiresSection: boolean,
	items: readonly DataProperty[],
	issues: PluginManifestIssue[]
): void {
	const ids = new Set<string>();
	forEachContributionItem(items, bucket, fields, issues, (entry, path) => {
		validateContributionLocalId(entry, path, ids, `${bucket} entry`, issues);
		if (requiresSection) validateSection(entry, path, issues);
		validateName(entry, path, issues);
		validateHref(entry, path, issues);
		validateIcon(entry, path, issues);
		validateOrder(entry, path, issues);
	});
}

function validateSection(
	entry: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const section = readDataProperty(entry, 'section', issues, true, path);
	if (section.kind !== 'value') return;
	if (
		typeof section.value !== 'string' ||
		section.value.length > MAX_SECTION_KEY_LENGTH ||
		!SECTION_KEY.test(section.value)
	) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.section`,
			`must be a lowercase kebab-case section key of at most ${MAX_SECTION_KEY_LENGTH} characters`
		);
	}
}

function validateName(
	entry: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const name = readDataProperty(entry, 'name', issues, true, path);
	if (
		name.kind === 'value' &&
		(typeof name.value !== 'string' ||
			name.value.replace(CONTROL_OR_FORMAT, '').trim().length < 1 ||
			name.value.length > MAX_NAME_LENGTH)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.name`,
			`must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`
		);
	}
}

function validateHref(
	entry: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const href = readDataProperty(entry, 'href', issues, true, path);
	if (href.kind === 'value' && !isSafeInternalNavPath(href.value)) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.href`,
			'must be an absolute internal path such as /dashboard/plugin/feature'
		);
	}
}

function validateIcon(
	entry: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const icon = readDataProperty(entry, 'icon', issues, true, path);
	if (icon.kind === 'value' && (typeof icon.value !== 'string' || !ICON.test(icon.value))) {
		addManifestIssue(
			issues,
			'invalid_format',
			`${path}.icon`,
			'must be an icon token such as lucide:sparkles'
		);
	}
}

function validateOrder(
	entry: Record<string, unknown>,
	path: string,
	issues: PluginManifestIssue[]
): void {
	const order = readDataProperty(entry, 'order', issues, false, path);
	if (
		order.kind === 'value' &&
		(typeof order.value !== 'number' ||
			!Number.isInteger(order.value) ||
			order.value < 0 ||
			order.value > MAX_ORDER)
	) {
		addManifestIssue(
			issues,
			'invalid_type',
			`${path}.order`,
			`must be an integer between 0 and ${MAX_ORDER}`
		);
	}
}
