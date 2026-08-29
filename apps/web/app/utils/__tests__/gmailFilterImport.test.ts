import { describe, expect, it } from 'vitest';
import { parseGmailFiltersXml } from '../gmailFilterImport';

function feed(...entries: string[]): string {
	return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>
	<title>Mail Filters</title>
	${entries.join('\n')}
</feed>`;
}

function entry(properties: Record<string, string>): string {
	const lines = Object.entries(properties)
		.map(([name, value]) => `\t\t<apps:property name='${name}' value='${value}'/>`)
		.join('\n');
	return `\t<entry>\n\t\t<category term='filter'></category>\n${lines}\n\t</entry>`;
}

describe('parseGmailFiltersXml', () => {
	it('translates a sender rule with a label and an archive', () => {
		const plan = parseGmailFiltersXml(
			feed(
				entry({
					from: 'billing@stripe.com',
					label: 'Money/Receipts',
					shouldArchive: 'true',
					shouldMarkAsRead: 'true',
				})
			)
		);
		expect(plan.untranslated).toEqual([]);
		expect(plan.filters).toHaveLength(1);
		expect(plan.filters[0]?.conditions).toEqual([
			{ field: 'from', op: 'contains', value: 'billing@stripe.com' },
		]);
		expect(plan.filters[0]?.actions).toEqual([
			{ type: 'addLabel', labelName: 'Money/Receipts' },
			{ type: 'moveToFolder', folderRole: 'archive' },
			{ type: 'markRead' },
		]);
	});

	it('names a filter after what it matches, since Gmail rules have no name', () => {
		const plan = parseGmailFiltersXml(feed(entry({ from: 'a@b.io', label: 'X' })));
		expect(plan.filters[0]?.name).toBe('from: a@b.io');
	});

	it('maps every criterion Owlat has a field for', () => {
		const plan = parseGmailFiltersXml(
			feed(
				entry({
					to: 'me+lists@x.io',
					subject: 'Invoice',
					hasTheWord: 'overdue',
					doesNotHaveTheWord: 'draft',
					hasAttachment: 'true',
					label: 'Bills',
				})
			)
		);
		expect(plan.filters[0]?.conditions).toEqual([
			{ field: 'to', op: 'contains', value: 'me+lists@x.io' },
			{ field: 'subject', op: 'contains', value: 'Invoice' },
			{ field: 'body', op: 'contains', value: 'overdue' },
			{ field: 'body', op: 'notContains', value: 'draft' },
			{ field: 'hasAttachment', op: 'isTrue' },
		]);
	});

	it('maps trash, spam and star', () => {
		const plan = parseGmailFiltersXml(
			feed(entry({ from: 'spam@x.io', shouldTrash: 'true', shouldStar: 'true' }))
		);
		expect(plan.filters[0]?.actions).toEqual([
			{ type: 'moveToFolder', folderRole: 'trash' },
			{ type: 'markFlagged' },
		]);
	});

	it('ignores a Gmail boolean that is not true', () => {
		const plan = parseGmailFiltersXml(
			feed(entry({ from: 'a@b.io', shouldArchive: 'false', label: 'Keep' }))
		);
		expect(plan.filters[0]?.actions).toEqual([{ type: 'addLabel', labelName: 'Keep' }]);
	});

	it('decodes XML entities in criteria and labels', () => {
		const plan = parseGmailFiltersXml(
			feed(entry({ subject: 'R&amp;D &quot;news&quot;', label: 'R&amp;D' }))
		);
		expect(plan.filters[0]?.conditions[0]?.value).toBe('R&D "news"');
		expect(plan.filters[0]?.actions[0]?.labelName).toBe('R&D');
	});

	it('reports a rule whose only action Owlat cannot honour', () => {
		const plan = parseGmailFiltersXml(feed(entry({ from: 'a@b.io', forwardTo: 'elsewhere@x.io' })));
		expect(plan.filters).toEqual([]);
		expect(plan.untranslated).toEqual([
			{
				description: 'from: a@b.io',
				reasonKey: 'shared.gmailFilterImport.reason.unsupportedAction',
			},
		]);
	});

	it('reports a rule whose only criterion Owlat cannot express', () => {
		const plan = parseGmailFiltersXml(
			feed(entry({ size: '1048576', sizeOperator: 's_sl', label: 'Big' }))
		);
		expect(plan.filters).toEqual([]);
		expect(plan.untranslated[0]?.reasonKey).toBe(
			'shared.gmailFilterImport.reason.unsupportedCriteria'
		);
	});

	it('separates the rules it can bring across from the ones it cannot', () => {
		const plan = parseGmailFiltersXml(
			feed(
				entry({ from: 'a@b.io', label: 'Keep' }),
				entry({ from: 'c@d.io', forwardTo: 'x@y.io' }),
				entry({ subject: 'Receipt', shouldArchive: 'true' })
			)
		);
		expect(plan.filters.map((filter) => filter.name)).toEqual(['from: a@b.io', 'subject: Receipt']);
		expect(plan.untranslated).toHaveLength(1);
	});

	it('returns an empty plan for a file that is not a filter export', () => {
		expect(parseGmailFiltersXml('<html><body>nope</body></html>')).toEqual({
			filters: [],
			untranslated: [],
		});
		expect(parseGmailFiltersXml('')).toEqual({ filters: [], untranslated: [] });
	});

	it('handles double-quoted attributes and self-closing variants', () => {
		const plan = parseGmailFiltersXml(
			`<feed><entry><apps:property name="from" value="a@b.io"></apps:property><apps:property name="label" value="Q" /></entry></feed>`
		);
		expect(plan.filters[0]?.actions).toEqual([{ type: 'addLabel', labelName: 'Q' }]);
	});
});
