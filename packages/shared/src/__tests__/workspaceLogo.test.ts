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

	it('refuses script hidden behind a namespace prefix or a character reference', () => {
		const svgs = [
			'<svg><x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script></svg>',
			'<svg><svg:foreignObject><div/></svg:foreignObject></svg>',
			'<svg><a href="javascript&#x3a;alert(1)"><rect/></a></svg>',
			'<svg><a href="javascript&#58;alert(1)"><rect/></a></svg>',
			'<svg><a href="&#106;avascript:alert(1)"><rect/></a></svg>',
			'<svg><a href="java\tscript:alert(1)"><rect/></a></svg>',
			'<svg><a href="java&#x09;script:alert(1)"><rect/></a></svg>',
			'<svg><rect x:onload="alert(1)"/></svg>',
		];
		for (const svg of svgs) {
			expect(workspaceLogoBytesProblem('image/svg+xml', encode(svg)), svg).toBe('unsafe-svg');
		}
	});

	it('refuses data: URIs and animations that rewrite a link', () => {
		const svgs = [
			'<svg><a href="data:text/html,<script>alert(1)</script>"><rect/></a></svg>',
			'<svg><image href="DATA:image/svg+xml;base64,PHN2Zz4="/></svg>',
			'<svg><a href="d&#97;ta:text/html,x"><rect/></a></svg>',
			'<svg><a><set attributeName="href" to="javascript&#x3a;alert(1)"/><rect/></a></svg>',
			'<svg><a><animate attributeName="xlink:href" values="https://example.com"/></a></svg>',
		];
		for (const svg of svgs) {
			expect(workspaceLogoBytesProblem('image/svg+xml', encode(svg)), svg).toBe('unsafe-svg');
		}
	});

	it('keeps an ordinary editor-exported SVG', () => {
		const svg = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">',
			'<metadata><rdf:RDF><dc:format>image/svg+xml</dc:format></rdf:RDF></metadata>',
			'<title>Northwind &amp; Co</title>',
			'<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>',
			'<g opacity="0.5"><path d="M0 0h10v10z" fill="url(#g)"/><use xlink:href="#g"/></g>',
			'<animateTransform attributeName="transform" type="rotate" dur="2s"/>',
			'</svg>',
		].join('\n');
		expect(workspaceLogoBytesProblem('image/svg+xml', encode(svg))).toBeNull();
	});
});
