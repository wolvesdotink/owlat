import { describe, it, expect } from 'vitest';
import { personalize } from '../personalization';

describe('personalize — basic variable replacement', () => {
	it('replaces a single variable with its value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: 'John' }, { escape: 'plain' })).toBe(
			'Hello John!',
		);
	});

	it('replaces multiple variables', () => {
		expect(
			personalize(
				'Hello {{firstName}} {{lastName}}!',
				{ firstName: 'John', lastName: 'Doe' },
				{ escape: 'plain' },
			),
		).toBe('Hello John Doe!');
	});

	it('returns content unchanged when no variables present', () => {
		expect(personalize('Hello there!', { firstName: 'John' }, { escape: 'plain' })).toBe(
			'Hello there!',
		);
	});

	it('handles mixed existing and missing variables', () => {
		expect(
			personalize(
				'Hello {{firstName}} {{lastName}}!',
				{ firstName: 'John' },
				{ escape: 'plain' },
			),
		).toBe('Hello John !');
	});

	it('handles adjacent variables', () => {
		expect(
			personalize(
				'{{firstName}}{{lastName}}',
				{ firstName: 'John', lastName: 'Doe' },
				{ escape: 'plain' },
			),
		).toBe('JohnDoe');
	});

	it('handles the same variable multiple times', () => {
		expect(
			personalize('Hi {{name}}, {{name}} is a great name!', { name: 'John' }, { escape: 'plain' }),
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
			'Hello !',
		);
	});

	it('returns empty string for null value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: null }, { escape: 'plain' })).toBe(
			'Hello !',
		);
	});

	it('returns empty string for empty-string value', () => {
		expect(personalize('Hello {{firstName}}!', { firstName: '' }, { escape: 'plain' })).toBe(
			'Hello !',
		);
	});
});

describe('personalize — fallback syntax', () => {
	it('uses fallback when variable is missing', () => {
		expect(personalize("Hello {{firstName|'friend'}}!", {}, { escape: 'plain' })).toBe(
			'Hello friend!',
		);
	});

	it('does NOT use fallback when variable has a value', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: 'John' }, { escape: 'plain' }),
		).toBe('Hello John!');
	});

	it('uses fallback when value is undefined', () => {
		expect(
			personalize(
				"Hello {{firstName|'friend'}}!",
				{ firstName: undefined },
				{ escape: 'plain' },
			),
		).toBe('Hello friend!');
	});

	it('uses fallback when value is null', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: null }, { escape: 'plain' }),
		).toBe('Hello friend!');
	});

	it('uses fallback when value is empty string', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}!", { firstName: '' }, { escape: 'plain' }),
		).toBe('Hello friend!');
	});

	it('handles empty fallback value', () => {
		expect(personalize("Hello {{firstName|''}}!", {}, { escape: 'plain' })).toBe('Hello !');
	});

	it('handles fallback with spaces', () => {
		expect(personalize("Hello {{firstName|'dear friend'}}!", {}, { escape: 'plain' })).toBe(
			'Hello dear friend!',
		);
	});

	it('handles multiple variables with different fallbacks', () => {
		expect(
			personalize("Hello {{firstName|'friend'}}, from {{company|'us'}}!", {}, { escape: 'plain' }),
		).toBe('Hello friend, from us!');
	});
});

describe('personalize — non-string values', () => {
	it('stringifies number values', () => {
		expect(personalize('You have {{count}} items.', { count: 42 }, { escape: 'plain' })).toBe(
			'You have 42 items.',
		);
	});

	it('stringifies boolean values', () => {
		expect(personalize('Active: {{isActive}}', { isActive: true }, { escape: 'plain' })).toBe(
			'Active: true',
		);
	});

	it('handles zero as a valid value', () => {
		expect(personalize('Count: {{count}}', { count: 0 }, { escape: 'plain' })).toBe('Count: 0');
	});

	it('handles false as a valid value', () => {
		expect(personalize('Status: {{status}}', { status: false }, { escape: 'plain' })).toBe(
			'Status: false',
		);
	});
});

describe('personalize — escape: plain (passthrough)', () => {
	it('does not escape HTML-significant characters in values', () => {
		expect(
			personalize('Hi {{firstName}}', { firstName: '<script>alert(1)</script>' }, { escape: 'plain' }),
		).toBe('Hi <script>alert(1)</script>');
	});

	it('does not escape ampersand or quotes', () => {
		expect(
			personalize('Hi {{name}}', { name: `O'Reilly & "Co"` }, { escape: 'plain' }),
		).toBe(`Hi O'Reilly & "Co"`);
	});

	it('does not escape fallback', () => {
		expect(personalize("Hi {{name|'<b>fallback</b>'}}", {}, { escape: 'plain' })).toBe(
			'Hi <b>fallback</b>',
		);
	});
});

describe('personalize — escape: html', () => {
	it('escapes <, >, &, ", and \' in values', () => {
		expect(
			personalize(
				'Hi {{firstName}}',
				{ firstName: `<a href="x">O'Reilly & Co</a>` },
				{ escape: 'html' },
			),
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

	it("escapes single quotes", () => {
		expect(personalize('{{name}}', { name: "a'b" }, { escape: 'html' })).toBe('a&#39;b');
	});

	it('escapes the fallback string the same way (consistency with worker)', () => {
		expect(personalize("Hi {{name|'<b>x</b>'}}", {}, { escape: 'html' })).toBe(
			'Hi &lt;b&gt;x&lt;/b&gt;',
		);
	});

	it('passes plain text unchanged when no HTML-significant characters present', () => {
		expect(personalize('Hi {{name}}', { name: 'John' }, { escape: 'html' })).toBe('Hi John');
	});
});
