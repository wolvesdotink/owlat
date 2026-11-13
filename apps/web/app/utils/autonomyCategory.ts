/**
 * A triage category in words ("Feature request"), never its raw enum. A
 * category the catalog has no name for yet (the server can add one before the
 * client learns it) reads with spaces for underscores instead of a key path.
 * Pure: the caller passes its own `t` and `te`.
 */
export function autonomyCategoryName(
	category: string,
	t: (key: string) => string,
	te: (key: string) => boolean
): string {
	const key = `components.autonomy.autonomyRuleEditor.categories.${category}`;
	return te(key) ? t(key) : category.replace(/_/g, ' ');
}
