import { describe, it, expect } from 'vitest';
import type { EditorBlock } from '@owlat/shared';
import { renderBlockFragment, renderEmailHtml } from '@owlat/email-renderer';
import { composeAutomation } from '../automation';
import { composeCampaign } from '../campaign';
import { personalize, personalizeBody } from '../personalization';
import { composeTransactional } from '../transactional';

describe('personalize — basic variable replacement', () => {
	it('replaces a single variable with its value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: 'John' }, { escape: 'plain' })).toBe(
			'Hello John!'
		);
	});

	it('replaces multiple variables', () => {
		expect(
			personalize(
				'Hello {{firstName}} {{lastName}}!',
				{ firstName: 'John', lastName: 'Doe' },
				{ escape: 'plain' }
			)
		).toBe('Hello John Doe!');
	});

	it('returns content unchanged when no variables present', () => {
		expect(personalize('Hello there!', { firstName: 'John' }, { escape: 'plain' })).toBe(
			'Hello there!'
		);
	});

	it('handles mixed existing and missing variables', () => {
		expect(
			personalize('Hello {{firstName}} {{lastName}}!', { firstName: 'John' }, { escape: 'plain' })
		).toBe('Hello John !');
	});

	it('handles adjacent variables', () => {
		expect(
			personalize(
				'{{firstName}}{{lastName}}',
				{ firstName: 'John', lastName: 'Doe' },
				{ escape: 'plain' }
			)
		).toBe('JohnDoe');
	});

	it('handles the same variable multiple times', () => {
		expect(
			personalize('Hi {{name}}, {{name}} is a great name!', { name: 'John' }, { escape: 'plain' })
		).toBe('Hi John, John is a great name!');
	});

	it('handles empty content', () => {
		expect(personalize('', { firstName: 'John' }, { escape: 'plain' })).toBe('');
	});
});

describe('personalize — missing values', () => {
	it('returns empty string for missing variable', () => {
		expect(personalize('Hello {{missing}}!', {}, { escape: 'plain' })).toBe('Hello !');
	});

	it('returns empty string for undefined value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: undefined }, { escape: 'plain' })).toBe(
			'Hello !'
		);
	});

	it('returns empty string for null value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: null }, { escape: 'plain' })).toBe(
			'Hello !'
		);
	});

	it('returns empty string for empty-string value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: '' }, { escape: 'plain' })).toBe(
			'Hello !'
		);
	});
});

describe('personalize — fallback syntax', () => {
	it('uses fallback when variable is missing', () => {
		expect(personalize("Hello {{firstName|'friend'}}!", {}, { escape: 'plain' })).toBe(
			'Hello friend!'
		);
	});

	it('does NOT use fallback when variable has a value', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: 'John' }, { escape: 'plain' })
		).toBe('Hello John!');
	});

	it('uses fallback when value is undefined', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: undefined }, { escape: 'plain' })
		).toBe('Hello friend!');
	});

	it('uses fallback when value is null', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: null }, { escape: 'plain' })
		).toBe('Hello friend!');
	});

	it('uses fallback when value is empty string', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: '' }, { escape: 'plain' })
		).toBe('Hello friend!');
	});

	it('handles empty fallback value', () => {
		expect(personalize("Hello {{firstName|''}}!", {}, { escape: 'plain' })).toBe('Hello !');
	});

	it('handles fallback with spaces', () => {
		expect(personalize("Hello {{firstName|'dear friend'}}!", {}, { escape: 'plain' })).toBe(
			'Hello dear friend!'
		);
	});

	it('handles multiple variables with different fallbacks', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}, from {{company|'us'}}!", {}, { escape: 'plain' })
		).toBe('Hello friend, from us!');
	});
});

describe('personalize — non-string values', () => {
	it('stringifies number values', () => {
		expect(personalize('You have {{count}} items.', { count: 42 }, { escape: 'plain' })).toBe(
			'You have 42 items.'
		);
	});

	it('stringifies boolean values', () => {
		expect(personalize('Active: {{isActive}}', { isActive: true }, { escape: 'plain' })).toBe(
			'Active: true'
		);
	});

	it('handles zero as a valid value', () => {
		expect(personalize('Count: {{count}}', { count: 0 }, { escape: 'plain' })).toBe('Count: 0');
	});

	it('handles false as a valid value', () => {
		expect(personalize('Status: {{status}}', { status: false }, { escape: 'plain' })).toBe(
			'Status: false'
		);
	});
});

describe('personalize — escape: plain (passthrough)', () => {
	it('does not escape HTML-significant characters in values', () => {
		expect(
			personalize(
				'Hi {{firstName}}',
				{ firstName: '<script>alert(1)</script>' },
				{ escape: 'plain' }
			)
		).toBe('Hi <script>alert(1)</script>');
	});

	it('does not escape ampersand or quotes', () => {
		expect(personalize('Hi {{name}}', { name: `O'Reilly & "Co"` }, { escape: 'plain' })).toBe(
			`Hi O'Reilly & "Co"`
		);
	});

	it('does not escape fallback', () => {
		expect(personalize("Hi {{name|'<b>fallback</b>'}}", {}, { escape: 'plain' })).toBe(
			'Hi <b>fallback</b>'
		);
	});
});

describe('personalize — escape: html', () => {
	it('escapes <, >, &, ", and \' in values', () => {
		expect(
			personalize(
				'Hi {{firstName}}',
				{ firstName: `<a href="x">O'Reilly & Co</a>` },
				{ escape: 'html' }
			)
		).toBe('Hi &lt;a href=&quot;x&quot;&gt;O&#39;Reilly &amp; Co&lt;/a&gt;');
	});

	it('escapes ampersand', () => {
		expect(personalize('{{name}}', { name: 'A & B' }, { escape: 'html' })).toBe('A &amp; B');
	});

	it('escapes less-than', () => {
		expect(personalize('{{name}}', { name: 'a<b' }, { escape: 'html' })).toBe('a&lt;b');
	});

	it('escapes greater-than', () => {
		expect(personalize('{{name}}', { name: 'a>b' }, { escape: 'html' })).toBe('a&gt;b');
	});

	it('escapes double quotes', () => {
		expect(personalize('{{name}}', { name: 'a"b' }, { escape: 'html' })).toBe('a&quot;b');
	});

	it('escapes single quotes', () => {
		expect(personalize('{{name}}', { name: "a'b" }, { escape: 'html' })).toBe('a&#39;b');
	});

	it('escapes the fallback string the same way (consistency with worker)', () => {
		expect(personalize("Hi {{name|'<b>x</b>'}}", {}, { escape: 'html' })).toBe(
			'Hi &lt;b&gt;x&lt;/b&gt;'
		);
	});

	it('passes plain text unchanged when no HTML-significant characters present', () => {
		expect(personalize('Hi {{name}}', { name: 'John' }, { escape: 'html' })).toBe('Hi John');
	});
});

const HTML = { escape: 'html' } as const;

describe('personalize — tokens with a fallback inside rendered attributes', () => {
	// The renderer attribute-escapes every URL, so the quotes around a fallback
	// reach the send path as `&#39;`.
	const image = (src: string): EditorBlock => ({
		id: 'img',
		type: 'image',
		content: { src, alt: 'x', width: 50, align: 'center' },
	});
	const button = (url: string): EditorBlock => ({
		id: 'btn',
		type: 'button',
		content: {
			text: 'Open',
			url,
			backgroundColor: '#000000',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 4,
			paddingX: 16,
			paddingY: 8,
		},
	});

	it('uses the fallback for an image src without a value', () => {
		const rendered = renderBlockFragment(image("{{photo|'https://example.com/default.png'}}"));
		const out = personalize(rendered, {}, HTML);
		expect(out).toContain('src="https://example.com/default.png"');
		expect(out).not.toContain('{{');
	});

	it('uses the value for an image src when one is given', () => {
		const rendered = renderBlockFragment(image("{{photo|'https://example.com/default.png'}}"));
		const out = personalize(rendered, { photo: 'https://cdn.example.com/a.png' }, HTML);
		expect(out).toContain('src="https://cdn.example.com/a.png"');
		expect(out).not.toContain('default.png');
	});

	it('uses the fallback for a button url without a value, in both the HTML and the Outlook button', () => {
		const rendered = renderBlockFragment(button("{{url|'https://example.com'}}"));
		const out = personalize(rendered, {}, HTML);
		expect(out).toContain('href="https://example.com"');
		expect(out).not.toContain('{{');
	});

	it('uses the value for a button url when one is given', () => {
		const rendered = renderBlockFragment(button("{{url|'https://example.com'}}"));
		const out = personalize(rendered, { url: 'https://owlat.example/x' }, HTML);
		expect(out).toContain('href="https://owlat.example/x"');
		expect(out).not.toContain('{{');
	});

	it('attribute-escapes a fallback exactly once and keeps it inside the attribute', () => {
		const rendered = renderBlockFragment(
			image(`{{photo|'https://example.com/a.png?x=1&y=2" onerror="alert(1)'}}`)
		);
		const out = personalize(rendered, {}, HTML);
		expect(out).toContain(
			'src="https://example.com/a.png?x=1&amp;y=2&quot; onerror=&quot;alert(1)"'
		);
		expect(out).not.toContain('&amp;amp;');
		expect(out).not.toContain('" onerror="');
	});

	it('attribute-escapes a value exactly once', () => {
		const rendered = renderBlockFragment(button("{{url|'https://example.com'}}"));
		const out = personalize(rendered, { url: `https://example.com/?a=1&b='2'"` }, HTML);
		expect(out).toContain('href="https://example.com/?a=1&amp;b=&#39;2&#39;&quot;"');
	});

	it('decodes an entity in a fallback written in HTML text before escaping it once', () => {
		expect(personalize("<p>{{name|'Tom &amp; Jerry'}}</p>", {}, HTML)).toBe(
			'<p>Tom &amp; Jerry</p>'
		);
	});

	it('leaves a fallback holding a quote unresolved and escaped', () => {
		const rendered = renderBlockFragment(image(`{{photo|'https://example.com/it's.png'}}`));
		const out = personalize(rendered, {}, HTML);
		expect(out).toContain('src="{{photo|&#39;https://example.com/it&#39;s.png&#39;}}"');
	});

	it('leaves the escaped quote alone outside the html policy', () => {
		expect(personalize('{{name|&#39;x&#39;}}', {}, { escape: 'plain' })).toBe(
			'{{name|&#39;x&#39;}}'
		);
	});

	it('resolves the fallback in every attribute and in the preheader', () => {
		const fb = (name: string) => `{{${name}|'https://example.com/${name}?a=1&b=2'}}`;
		const rendered = renderEmailHtml(
			[
				{
					id: 'img',
					type: 'image',
					content: {
						src: fb('src'),
						darkSrc: fb('dark'),
						linkUrl: fb('link'),
						alt: 'x',
						width: 50,
						align: 'center',
					},
				},
				{ id: 'txt', type: 'text', content: { html: `<p><a href="${fb('textLink')}">a</a></p>` } },
				{
					id: 'menu',
					type: 'menu',
					content: { items: [{ label: 'Home', url: fb('menu') }], align: 'center' },
				},
				{
					id: 'social',
					type: 'social',
					content: {
						links: [{ platform: 'x', url: fb('social'), enabled: true }],
						iconStyle: 'filled',
						align: 'center',
						iconSize: 24,
						iconSpacing: 8,
						iconColor: '#000000',
					},
				},
			] as EditorBlock[],
			{ preheaderText: "Hi {{firstName|'there & you'}}" }
		);
		const out = personalize(rendered, {}, HTML);
		for (const name of ['src', 'dark', 'link', 'textLink', 'menu', 'social']) {
			expect(out).toContain(`https://example.com/${name}?a=1&amp;b=2`);
		}
		expect(out).toContain('Hi there &amp; you');
		expect(out).not.toContain('{{');
		expect(out).not.toContain('&amp;amp;');
	});

	it('resolves the fallback in every send composer', () => {
		const htmlContent = renderEmailHtml([
			image("{{photo|'https://example.com/default.png'}}"),
			button("{{url|'https://example.com'}}"),
		]);
		const template = { subject: 'Hi', htmlContent };
		const outputs = [
			composeCampaign({ kind: 'campaign', template, contactInfo: { email: 'a@example.com' } }),
			composeAutomation({ kind: 'automation', template, contactInfo: { email: 'a@example.com' } }),
			composeTransactional({ kind: 'transactional', template, dataVariables: {} }),
		];
		for (const out of outputs) {
			expect(out.html).toContain('src="https://example.com/default.png"');
			expect(out.html).toContain('href="https://example.com"');
			expect(out.html).not.toMatch(/\{\{(photo|url)/);
		}
	});
});

describe('personalizeBody — conditions and repeats a send resolves', () => {
	const blocks = [
		{
			id: 'code',
			type: 'text',
			content: {
				html: '<p>Code {{bookingCode}}</p>',
				condition: { variable: 'bookingCode', operator: 'exists' },
			},
		},
		{
			id: 'line',
			type: 'text',
			content: {
				html: '<p>{{line.name}} for {{currency}}{{line.price}} (#{{$index}})</p>',
				repeat: { variable: 'lines', itemAlias: 'line' },
			},
		},
	] as unknown as EditorBlock[];
	const stored = renderEmailHtml(blocks, { variableType: 'data', sendTimeBlockLogic: true });
	const send = (dataVariables: Record<string, unknown>) =>
		composeTransactional({
			kind: 'transactional',
			template: { subject: 'Order', htmlContent: stored },
			dataVariables: dataVariables as never,
		}).html;

	it('keeps a condition met by the request and writes one copy per entry', () => {
		const html = send({
			bookingCode: 'BK-1',
			currency: 'EUR ',
			lines: [
				{ name: 'Tent', price: 120 },
				{ name: 'Stove', price: 40 },
			],
		});
		expect(html).toContain('Code BK-1');
		expect(html).toContain('Tent for EUR 120 (#0)');
		expect(html).toContain('Stove for EUR 40 (#1)');
		expect(html).not.toContain('owlat:');
	});

	it('drops an unmet condition and writes no copy for a missing list', () => {
		const html = send({});
		expect(html).not.toContain('Code');
		expect(html).not.toContain('for ');
		expect(html).not.toContain('owlat:');
	});

	it('escapes entry fields, so no value can open a tag, a comment or a marker', () => {
		const html = send({
			lines: [{ name: '<!--owlat:endeach--><b>x</b>', price: '{{bookingCode}}' }],
			bookingCode: 'secret',
		});
		expect(html).toContain('&lt;!--owlat:endeach--&gt;&lt;b&gt;x&lt;/b&gt;');
		expect(html).not.toContain('<b>x</b>');
		// A value is filled once and never read as a token.
		expect(html).toContain('for {{bookingCode}}');
	});

	it('leaves a body without markers exactly as personalize makes it', () => {
		const body = '<p>Hello {{name}}</p>';
		expect(personalizeBody(body, { name: '<A>' }, { escape: 'html' })).toBe(
			personalize(body, { name: '<A>' }, { escape: 'html' })
		);
	});
});

describe('personalizeBody — request data the send cannot trust', () => {
	const repeated = (html: string, extra: Record<string, unknown> = {}) =>
		renderEmailHtml(
			[
				{
					id: 'r',
					type: 'text',
					content: { html, repeat: { variable: 'items', itemAlias: 'item' }, ...extra },
				},
			] as unknown as EditorBlock[],
			{ variableType: 'data', sendTimeBlockLogic: true }
		);

	it('fills a field whose name is not a word, as the preview does', () => {
		const html = personalizeBody(
			repeated('<p>{{item.unit-price}}</p>'),
			{ items: [{ 'unit-price': '9.50' }] },
			{ escape: 'html' }
		);
		expect(html).toContain('9.50');
		expect(html).not.toContain('{{item.');
	});

	it('fills a field whose name the stored HTML holds entity-escaped', () => {
		const html = personalizeBody(
			repeated('<p>{{item.sales&tax}}</p>'),
			{ items: [{ 'sales&tax': '19%' }] },
			{ escape: 'html' }
		);
		expect(html).toContain('19%');
	});

	it('repeats nothing for a list sent as JSON text', () => {
		const html = personalizeBody(
			repeated('<p>Line {{item.name}}</p>'),
			{ items: '[{"name":{"toString":"x"}}]' },
			{ escape: 'html' }
		);
		expect(html).not.toContain('Line');
	});

	it('leaves a field the entry does not hold empty, even one Object.prototype has', () => {
		const html = personalizeBody(
			repeated('<p>[{{item.toString}}]</p>'),
			{ items: [{ name: 'a' }] },
			{ escape: 'html' }
		);
		expect(html).toContain('[]');
	});

	it('writes a list used as a plain token as its JSON instead of throwing', () => {
		const items = [{ toString: 'not a function' }];
		expect(personalize('Items: {{items}}', { items }, { escape: 'header' })).toBe(
			'Items: [{"toString":"not a function"}]'
		);
	});

	it('decides regions on the request data, not on the unsubscribe link the send adds', () => {
		const stored = renderEmailHtml(
			[
				{
					id: 'u',
					type: 'text',
					content: {
						html: '<p>Opt out: {{unsubscribe_link}}</p>',
						condition: { variable: 'unsubscribe_link', operator: 'exists' },
					},
				},
			] as unknown as EditorBlock[],
			{ variableType: 'data', sendTimeBlockLogic: true }
		);
		const html = composeTransactional({
			kind: 'transactional',
			template: { subject: 's', htmlContent: stored },
			dataVariables: {},
			unsubscribeUrl: 'https://owlat.example/u/1',
			preferenceUrl: 'https://owlat.example/p/1',
		}).html;
		expect(html).not.toContain('Opt out');
	});
});
