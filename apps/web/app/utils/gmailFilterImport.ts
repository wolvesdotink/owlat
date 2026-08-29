/**
 * Gmail's exported filters → Owlat mail filters (idea 50).
 *
 * "Download your data" gets a Gmail user their mail; exporting their filters
 * gets them the rules that made the mailbox liveable. Without those, an imported
 * archive is a pile — every rule about where new mail goes has to be rebuilt by
 * hand, which is the point most people give up.
 *
 * Gmail's export is an Atom feed of `<entry>` elements, each a flat list of
 * `<apps:property name value>` pairs mixing criteria and actions:
 *
 *     <entry>
 *       <apps:property name='from' value='billing@stripe.com'/>
 *       <apps:property name='label' value='Money/Receipts'/>
 *       <apps:property name='shouldArchive' value='true'/>
 *     </entry>
 *
 * Parsed with a scanner rather than `DOMParser`: this must run in a unit test
 * without a DOM, and a hand-rolled scanner over a known-shape feed has no XML
 * entity expansion to worry about at all.
 *
 * WHAT DOES NOT TRANSLATE IS REPORTED, NOT DROPPED. Gmail has vocabulary Owlat
 * has no equivalent for (its size operators, "never send to spam",
 * auto-forwarding). A filter that ends up with no condition or no action Owlat
 * can honour is returned in {@link GmailFilterImportPlan.untranslated} with the
 * property that defeated it, so the card can say which rules the user still has
 * to rebuild instead of quietly importing three of their eleven filters.
 */

/** Fields an imported condition can test. Mirrors `mail/filtersImport.ts`. */
export type ImportedFilterField = 'from' | 'to' | 'subject' | 'body' | 'hasAttachment';

export interface ImportedFilterCondition {
	field: ImportedFilterField;
	op: 'contains' | 'notContains' | 'isTrue';
	value?: string;
}

export interface ImportedFilterAction {
	type: 'addLabel' | 'moveToFolder' | 'markRead' | 'markFlagged';
	labelName?: string;
	folderRole?: 'archive' | 'trash' | 'spam';
}

export interface ImportedFilter {
	name: string;
	conditions: ImportedFilterCondition[];
	actions: ImportedFilterAction[];
}

/** A filter that could not be brought across, and why. */
export interface UntranslatedFilter {
	/** The criteria as Gmail wrote them, for the "rebuild this one" line. */
	description: string;
	/** Catalog key naming the reason. */
	reasonKey: string;
}

export interface GmailFilterImportPlan {
	filters: ImportedFilter[];
	untranslated: UntranslatedFilter[];
}

const ENTRY_PATTERN = /<entry\b[\s\S]*?<\/entry>/g;
const PROPERTY_PATTERN = /<apps:property\s+name=(['"])(.*?)\1\s+value=(['"])([\s\S]*?)\3\s*\/?>/g;

const XML_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

/** Decode the five XML entities plus numeric references. */
function decodeXml(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
		if (entity.startsWith('#x') || entity.startsWith('#X')) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith('#')) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return XML_ENTITIES[entity] ?? match;
	});
}

function properties(entry: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const match of entry.matchAll(PROPERTY_PATTERN)) {
		const name = match[2];
		const value = match[4];
		if (name === undefined || value === undefined) continue;
		found.set(name, decodeXml(value));
	}
	return found;
}

function isTrue(value: string | undefined): boolean {
	return value === 'true';
}

/** Gmail criteria that map to a condition, in the order they read best. */
const CRITERIA: ReadonlyArray<
	readonly [property: string, field: ImportedFilterField, op: 'contains' | 'notContains']
> = [
	['from', 'from', 'contains'],
	['to', 'to', 'contains'],
	['subject', 'subject', 'contains'],
	['hasTheWord', 'body', 'contains'],
	['doesNotHaveTheWord', 'body', 'notContains'],
];

/**
 * Gmail properties that carry meaning Owlat cannot honour. Their presence alone
 * does not fail a filter — it only matters when nothing else translated, which
 * is what {@link untranslatableReason} decides.
 */
const UNSUPPORTED_CRITERIA = ['size', 'sizeOperator', 'hasTheWord:list'] as const;
const UNSUPPORTED_ACTIONS = ['forwardTo', 'shouldNeverSpam', 'smartLabelToApply'] as const;

function untranslatableReason(found: Map<string, string>, hasConditions: boolean): string {
	if (!hasConditions) {
		return UNSUPPORTED_CRITERIA.some((key) => found.has(key))
			? 'shared.gmailFilterImport.reason.unsupportedCriteria'
			: 'shared.gmailFilterImport.reason.noConditions';
	}
	return UNSUPPORTED_ACTIONS.some((key) => found.has(key))
		? 'shared.gmailFilterImport.reason.unsupportedAction'
		: 'shared.gmailFilterImport.reason.noActions';
}

/**
 * A readable name for a Gmail filter, which has none of its own.
 *
 * Built from the criteria the rule matches on, because that is how its owner
 * thinks of it ("the one for Stripe"). Truncated: it becomes a filter name.
 */
function describe(found: Map<string, string>): string {
	const parts = CRITERIA.filter(([property]) => found.get(property))
		.map(([property]) => `${property}: ${found.get(property)}`)
		.slice(0, 2);
	if (isTrue(found.get('hasAttachment'))) parts.push('has attachment');
	return (parts.join(', ') || 'Gmail filter').slice(0, 120);
}

function conditionsOf(found: Map<string, string>): ImportedFilterCondition[] {
	const conditions: ImportedFilterCondition[] = [];
	for (const [property, field, op] of CRITERIA) {
		const value = found.get(property)?.trim();
		if (value) conditions.push({ field, op, value });
	}
	if (isTrue(found.get('hasAttachment'))) {
		conditions.push({ field: 'hasAttachment', op: 'isTrue' });
	}
	return conditions;
}

function actionsOf(found: Map<string, string>): ImportedFilterAction[] {
	const actions: ImportedFilterAction[] = [];
	const label = found.get('label')?.trim();
	if (label) actions.push({ type: 'addLabel', labelName: label });
	// Gmail's "skip the inbox" IS an archive, and its trash action is a delete
	// that keeps the message — both are folder moves here.
	if (isTrue(found.get('shouldArchive'))) {
		actions.push({ type: 'moveToFolder', folderRole: 'archive' });
	}
	if (isTrue(found.get('shouldTrash'))) {
		actions.push({ type: 'moveToFolder', folderRole: 'trash' });
	}
	if (isTrue(found.get('shouldSpam'))) {
		actions.push({ type: 'moveToFolder', folderRole: 'spam' });
	}
	if (isTrue(found.get('shouldMarkAsRead'))) actions.push({ type: 'markRead' });
	if (isTrue(found.get('shouldStar'))) actions.push({ type: 'markFlagged' });
	return actions;
}

/**
 * Translate a Gmail filter export.
 *
 * Returns what can be created and what cannot, never throws on a malformed
 * file: a feed with no recognisable entries yields an empty plan, which the
 * card reports as "no filters found" rather than as an error the user cannot
 * act on.
 */
export function parseGmailFiltersXml(xml: string): GmailFilterImportPlan {
	const filters: ImportedFilter[] = [];
	const untranslated: UntranslatedFilter[] = [];

	for (const [entry] of xml.matchAll(ENTRY_PATTERN)) {
		const found = properties(entry);
		if (found.size === 0) continue;
		const conditions = conditionsOf(found);
		const actions = actionsOf(found);
		if (conditions.length === 0 || actions.length === 0) {
			untranslated.push({
				description: describe(found),
				reasonKey: untranslatableReason(found, conditions.length > 0),
			});
			continue;
		}
		filters.push({ name: describe(found), conditions, actions });
	}

	return { filters, untranslated };
}
