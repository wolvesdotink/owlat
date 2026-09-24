import { describe, expect, it } from 'vitest';
import {
	MAX_WORKSPACE_LOGO_BYTES,
	workspaceLogoBytesProblem,
	workspaceLogoFileProblem,
} from '../workspaceLogo';

const encode = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

describe('workspaceLogoFileProblem', () => {
	it('accepts PNG, JPEG and SVG up to the size limit', () => {
		for (const type of ['image/png', 'image/jpeg', 'image/svg+xml']) {
			expect(workspaceLogoFileProblem({ type, size: MAX_WORKSPACE_LOGO_BYTES })).toBeNull();
		}
	});

	it('refuses other formats, empty files and files over the limit', () => {
		expect(workspaceLogoFileProblem({ type: 'image/gif', size: 10 })).toBe('type');
		expect(workspaceLogoFileProblem({ type: 'image/webp', size: 10 })).toBe('type');
		expect(workspaceLogoFileProblem({ type: 'image/png', size: 0 })).toBe('empty');
		expect(
			workspaceLogoFileProblem({ type: 'image/png', size: MAX_WORKSPACE_LOGO_BYTES + 1 })
		).toBe('size');
	});
});

describe('workspaceLogoBytesProblem', () => {
	it('accepts bytes that carry the declared format signature', () => {
		expect(workspaceLogoBytesProblem('image/png', PNG)).toBeNull();
		expect(workspaceLogoBytesProblem('image/jpeg', JPEG)).toBeNull();
		expect(
			workspaceLogoBytesProblem(
				'image/svg+xml',
				encode(
					String.fromCharCode(0xfeff) +
						'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>'
				)
			)
		).toBeNull();
	});

	it('refuses bytes that do not match the declared type', () => {
		expect(workspaceLogoBytesProblem('image/png', JPEG)).toBe('signature');
		expect(workspaceLogoBytesProblem('image/jpeg', PNG)).toBe('signature');
		expect(workspaceLogoBytesProblem('image/svg+xml', PNG)).toBe('signature');
		expect(workspaceLogoBytesProblem('image/svg+xml', encode('<html><body>hi</body></html>'))).toBe(
			'signature'
		);
		expect(workspaceLogoBytesProblem('image/gif', encode('GIF89a'))).toBe('signature');
	});

	it('refuses an SVG that could run script when its URL is opened directly', () => {
		const svgs = [
			'<svg><script>alert(1)</script></svg>',
			'<svg><rect onload="alert(1)"/></svg>',
			'<svg><a href="javascript:alert(1)"><rect/></a></svg>',
			'<svg><foreignObject><div/></foreignObject></svg>',
			'<!DOCTYPE svg [<!ENTITY x "y">]><svg>&x;</svg>',
		];
		for (const svg of svgs) {
			expect(workspaceLogoBytesProblem('image/svg+xml', encode(svg))).toBe('unsafe-svg');
		}
	});
});
