import { describe, it, expect } from 'vitest';
import {
	SENT_PREVIEW_PANES,
	buildSentPreview,
	isEmptyPlainText,
	sentPreviewSrcdoc,
} from '../postboxSentPreview';
import { createTestI18n } from '~/__tests__/i18n';

// The panes carry catalog KEYS, not copy — the component resolves them.
const { t } = createTestI18n().global;

describe('SENT_PREVIEW_PANES', () => {
	it('names the three parts in the order they are shown', () => {
		expect(SENT_PREVIEW_PANES.map((p) => p.id)).toEqual(['html', 'plain', 'dark']);
	});

	it('has a translation for every pane label', () => {
		for (const pane of SENT_PREVIEW_PANES) {
			expect(t(pane.labelKey)).not.toBe(pane.labelKey);
		}
	});
});

describe('buildSentPreview', () => {
	const draft = {
		composerMode: 'simple',
		bodyHtml: '<p>Hi Ines,</p><p>Numbers attached.</p>',
		subject: 'Invoice 4471',
	};

	it('derives the HTML, the real plain-text alternative and a dark rendering', () => {
		const preview = buildSentPreview(draft);
		expect(preview.html).toContain('Numbers attached.');
		expect(preview.text).toContain('Numbers attached.');
		expect(preview.text).not.toMatch(/<[a-z]/i);
		expect(preview.dark).not.toBe(preview.html);
		expect(preview.hasAmp).toBe(false);
	});

	it('reports the AMP alternative that ships with an interactive design', () => {
		const preview = buildSentPreview({
			composerMode: 'full',
			bodyBlocks: JSON.stringify([
				{ id: 'a', type: 'accordion', content: { sections: [{ id: 's', title: 'T', items: [] }] } },
			]),
		});
		expect(preview.hasAmp).toBe(true);
	});
});

describe('sentPreviewSrcdoc', () => {
	it('puts the CSP meta first inside the head', () => {
		const out = sentPreviewSrcdoc(
			'<!doctype html><html><head><title>x</title></head><body>b</body></html>'
		);
		expect(out).toContain('Content-Security-Policy');
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
		expect(out).toMatch(/default-src 'none'/);
		// Scripts are not in the allowlist at all.
		expect(out).not.toMatch(/script-src/);
	});

	it('still applies the policy to a fragment with no head', () => {
		const out = sentPreviewSrcdoc('<p>bare</p>');
		expect(out.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
		expect(out).toContain('<p>bare</p>');
	});
});

describe('isEmptyPlainText', () => {
	it('treats a whitespace-only alternative as empty', () => {
		expect(isEmptyPlainText('   \n\t ')).toBe(true);
		expect(isEmptyPlainText('')).toBe(true);
		expect(isEmptyPlainText('Hi')).toBe(false);
	});
});
