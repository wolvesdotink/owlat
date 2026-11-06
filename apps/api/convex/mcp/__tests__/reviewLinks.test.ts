import { describe, expect, it } from 'vitest';
import { reviewLinks } from '../reviewLinks';

describe('reviewLinks', () => {
	it('finds links that markup tricks would hide from a regex, and flags text that names another host', () => {
		const html =
			'<a title=">" href="https://attacker.example/a">trusted.example</a>' +
			'<a href=https://attacker.example/b><style>.x{}</style>www.trusted.example</a>' +
			'<a href="javascript:alert(1)">https://trusted.example</a>' +
			'<a href="https://one.example">first<a href="https://two.example">second</a>' +
			'<map><area href="https://attacker.example/c" alt="trusted.example"></map>';
		expect(reviewLinks({ html, text: '' })).toEqual([
			{
				part: 'html',
				href: 'https://attacker.example/a',
				host: 'attacker.example',
				text: 'trusted.example',
				shownHost: 'trusted.example',
			},
			{
				part: 'html',
				href: 'https://attacker.example/b',
				host: 'attacker.example',
				text: 'www.trusted.example',
				shownHost: 'trusted.example',
			},
			{
				part: 'html',
				href: 'javascript:alert(1)',
				host: null,
				text: 'https://trusted.example',
				shownHost: 'trusted.example',
			},
			{ part: 'html', href: 'https://one.example', host: 'one.example', text: 'first' },
			{ part: 'html', href: 'https://two.example', host: 'two.example', text: 'second' },
			{
				part: 'html',
				href: 'https://attacker.example/c',
				host: 'attacker.example',
				text: 'trusted.example',
				shownHost: 'trusted.example',
			},
		]);
	});

	it('lists a repeated link once per part', () => {
		const html = '<a href="https://owlat.test/x">Open</a><a href="https://owlat.test/x">Open</a>';
		expect(reviewLinks({ html, text: 'https://owlat.test/x and https://owlat.test/x' })).toEqual([
			{ part: 'html', href: 'https://owlat.test/x', host: 'owlat.test', text: 'Open' },
			{ part: 'text', href: 'https://owlat.test/x', host: 'owlat.test' },
		]);
	});
});
