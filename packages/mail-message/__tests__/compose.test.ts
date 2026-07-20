/**
 * `buildRfc822` composition against the neutral `ComposeInput`, plus the
 * attachment `Buffer | base64 string` boundary the Convex send path relies on
 * (storage fetching decodes to bytes before the composer runs).
 */

import { describe, it, expect } from 'vitest';
import { buildRfc822 } from '../src/index';
import { makeInput } from './helpers';

describe('buildRfc822 (ComposeInput)', () => {
	it('emits exactly one domain-scoped Message-ID and never leaks Bcc into headers', () => {
		const { raw } = buildRfc822(
			makeInput({ toAddresses: ['a@x.test'], bccAddresses: ['secret@y.test'] }),
			[],
			'<abc@acme.test>',
			undefined,
			undefined
		);
		const eml = raw.toString('utf-8');
		expect(eml).toMatch(/^Message-ID: <abc@acme\.test>\r\n/);
		expect((eml.match(/^Message-ID: /gm) ?? []).length).toBe(1);
		expect(eml.split('\r\n\r\n')[0]).not.toContain('secret@y.test');
	});

	it('never emits Content-Transfer-Encoding: 8bit', () => {
		const { raw } = buildRfc822(
			makeInput({ bodyHtml: '<p>Grüße — café ☕</p>', bodyText: undefined }),
			[],
			'<id@owlat.test>',
			undefined,
			undefined
		);
		const eml = raw.toString('utf-8');
		expect(eml).not.toContain('Content-Transfer-Encoding: 8bit');
		expect(eml).toMatch(/Content-Transfer-Encoding: (quoted-printable|base64)/);
	});

	it('treats a base64-string attachment identically to its decoded Buffer', () => {
		const bytes = Buffer.from('hello attachment payload');
		const common = {
			filename: 'note.txt',
			contentType: 'text/plain',
			isInline: false,
		};
		const fromBuffer = buildRfc822(
			makeInput(),
			[{ ...common, data: bytes }],
			'<id@owlat.test>',
			undefined,
			undefined
		).raw.toString('utf-8');
		const fromBase64 = buildRfc822(
			makeInput(),
			[{ ...common, data: bytes.toString('base64') }],
			'<id@owlat.test>',
			undefined,
			undefined
		).raw.toString('utf-8');

		// The base64 payload line must match between the two representations. Strip
		// the non-deterministic Date header and boundary tokens before comparing.
		const normalize = (eml: string) =>
			eml.replace(/^Date: .*$/m, 'Date: X').replace(/--_owlat_[0-9a-f]+/g, '--_owlat_B');
		expect(normalize(fromBase64)).toBe(normalize(fromBuffer));
		expect(fromBuffer).toContain('Content-Disposition: attachment; filename="note.txt"');
	});

	it('rejects a string attachment that is not valid base64 (raw text passed by mistake)', () => {
		expect(() =>
			buildRfc822(
				makeInput(),
				[
					{
						filename: 'note.txt',
						contentType: 'text/plain',
						isInline: false,
						data: 'this is raw text, not base64!',
					},
				],
				'<id@owlat.test>',
				undefined,
				undefined
			)
		).toThrow(/base64/);
	});
});
