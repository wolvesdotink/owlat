// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { applyClientSimulation } from '../clientSimulation';
import type { EmailClient } from '../types';

function client(family: EmailClient['family'], id = `${family}-test`): EmailClient {
	return { id, family, platform: 'desktop-webmail', name: id, icon: 'mail' };
}

const HTML = [
	'<div style="color: red; mix-blend-mode: multiply; clip-path: circle(50%)">',
	'  <video src="x.mp4"></video>',
	'  <p style="filter: blur(2px)">text</p>',
	'  <img src="https://cdn.example.com/logo.png" alt="logo">',
	'</div>',
].join('\n');

describe('applyClientSimulation', () => {
	it('strips CSS declarations a Gmail-family client does not support', () => {
		const result = applyClientSimulation(HTML, client('gmail'), null);
		expect(result.html).not.toContain('mix-blend-mode');
		expect(result.html).not.toContain('clip-path');
		expect(result.html).toContain('color: red');
		expect(result.removedCssDeclarations).toBeGreaterThanOrEqual(2);
	});

	it('removes elements the client cannot render and counts them', () => {
		const result = applyClientSimulation(HTML, client('gmail'), null);
		expect(result.html).not.toContain('<video');
		expect(result.removedElements).toBe(1);
	});

	it('keeps filter for gmail but strips it for outlook', () => {
		const gmail = applyClientSimulation(HTML, client('gmail'), null);
		expect(gmail.html).toContain('filter: blur(2px)');

		const outlook = applyClientSimulation(HTML, client('outlook'), null);
		expect(outlook.html).not.toContain('filter: blur');
	});

	it('blocks remote images for privacy-first clients (protonmail)', () => {
		const result = applyClientSimulation(HTML, client('protonmail'), null);
		expect(result.blockedImages).toBe(1);
		expect(result.html).not.toContain('https://cdn.example.com/logo.png');
	});

	it('merges per-client overrides on top of the family profile', () => {
		// gmail-webmail additionally strips id attributes and position rules.
		const html = '<p id="keepme" style="position: absolute; color: blue">x</p>';
		const result = applyClientSimulation(html, client('gmail', 'gmail-webmail'), null);
		expect(result.html).not.toContain('position: absolute');
		expect(result.html).not.toContain('id="keepme"');
		expect(result.strippedAttributes).toBeGreaterThanOrEqual(1);
	});

	it('returns the input untouched for a family with no profile', () => {
		const result = applyClientSimulation(HTML, client('applemail' as EmailClient['family']), null);
		expect(result).toMatchObject({
			html: HTML,
			removedCssDeclarations: 0,
			removedElements: 0,
			blockedImages: 0,
		});
	});

	it('does not let a property prefix strip unrelated declarations', () => {
		// 'filter' must not match 'backdrop-filter'-style prefixes or substrings.
		const html = '<p style="color: aliceblue; --my-filter-var: 1">x</p>';
		const result = applyClientSimulation(html, client('outlook'), null);
		expect(result.html).toContain('color: aliceblue');
	});
});
