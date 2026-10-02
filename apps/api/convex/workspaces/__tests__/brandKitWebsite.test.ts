/**
 * Reading a brand out of a website's HTML (`brandKitWebsite.ts`): the signals
 * the import proposes a kit from, and the guarantee that hostile markup costs
 * linear time.
 */
import { describe, expect, it } from 'vitest';
import {
	countCssColors,
	extractWebsiteSignals,
	normalizeColor,
	parseAttributes,
	proposeBrandKit,
} from '../brandKitWebsite';

const PAGE = `<!doctype html>
<html><head>
	<title>Northwind &amp; Co — Home</title>
	<meta name="theme-color" content="#0F766E">
	<meta property="og:site_name" content="Northwind">
	<meta property="og:image" content="/share.jpg">
	<link rel="icon" href="/favicon.ico">
	<link rel="icon" type="image/svg+xml" href="/icon.svg">
	<link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
	<link rel="stylesheet" href="/site.css">
	<link rel="stylesheet" href="javascript:alert(1)">
	<style>body { color: #1f2937; background: #ffffff } a { color: #0f766e }</style>
</head><body>
	<img class="site-logo" src="logo.svg" alt="Northwind">
	<img src="/hero.jpg" alt="A hero">
	<div style="background-color: rgb(250, 204, 21)">Sale</div>
</body></html>`;

describe('extractWebsiteSignals', () => {
	const signals = extractWebsiteSignals(PAGE, 'https://www.example.com/about/');

	it('reads the theme colour and the site name', () => {
		expect(signals.themeColor).toBe('#0f766e');
		expect(signals.siteName).toBe('Northwind');
	});

	it('ranks the logo candidates and resolves them against the page', () => {
		expect(signals.logoCandidates).toEqual([
			{ url: 'https://cdn.example.com/touch.png', source: 'appleTouchIcon' },
			{ url: 'https://www.example.com/about/logo.svg', source: 'logoImage' },
			{ url: 'https://www.example.com/icon.svg', source: 'icon' },
			{ url: 'https://www.example.com/share.jpg', source: 'ogImage' },
		]);
	});

	it('keeps only http(s) stylesheets and collects inline CSS', () => {
		expect(signals.stylesheetUrls).toEqual(['https://www.example.com/site.css']);
		expect(signals.inlineCss).toContain('#1f2937');
		expect(signals.inlineCss).toContain('rgb(250, 204, 21)');
	});

	it('falls back to the title when there is no og:site_name', () => {
		const page = '<title>  Example   Studio </title>';
		expect(extractWebsiteSignals(page, 'https://example.com/').siteName).toBe('Example Studio');
	});
});

describe('parseAttributes', () => {
	it('reads quoted, single-quoted and bare values, first one wins', () => {
		expect(parseAttributes(`<link REL=icon href='/a.png' href="/b.png" data-x="a&amp;b">`)).toEqual(
			{ rel: 'icon', href: '/a.png', 'data-x': 'a&b' }
		);
	});

	it('stays fast on a hostile tag', () => {
		const tag = `<meta ${'a'.repeat(200_000)}${'= '.repeat(50_000)}>`;
		const started = performance.now();
		parseAttributes(tag);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('colours', () => {
	it('normalizes hex and rgb colours', () => {
		expect(normalizeColor('#ABC')).toBe('#aabbcc');
		expect(normalizeColor('rgb(15, 118, 110)')).toBe('#0f766e');
		expect(normalizeColor('rgba(0,0,0,0.5)')).toBe('#000000');
		expect(normalizeColor('rgb(300, 0, 0)')).toBeNull();
		expect(normalizeColor('red')).toBeNull();
	});

	it('counts colours, most used first', () => {
		expect(countCssColors('#fff; #ffffff; #0f766e; rgb(255,255,255)').slice(0, 2)).toEqual([
			{ color: '#ffffff', count: 3 },
			{ color: '#0f766e', count: 1 },
		]);
	});

	it('scans a large stylesheet quickly', () => {
		const css = `${'rgb(   '.repeat(100_000)}#123456`;
		const started = performance.now();
		countCssColors(css);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe('proposeBrandKit', () => {
	it('takes the theme colour as primary and fills text, background and swatches', () => {
		const signals = extractWebsiteSignals(PAGE, 'https://www.example.com/');
		const css = `${signals.inlineCss} .a{color:#7c3aed} .b{color:#7c3aed} .c{color:#facc15}`;
		const proposal = proposeBrandKit(signals, countCssColors(css));
		expect(proposal.primaryColor).toBe('#0f766e');
		expect(proposal.textColor).toBe('#1f2937');
		expect(proposal.backgroundColor).toBe('#ffffff');
		expect(proposal.secondaryColor).toBe('#7c3aed');
		expect(proposal.linkColor).toBe('#0f766e');
		expect(proposal.swatches).toContain('#facc15');
		expect(proposal.companyName).toBe('Northwind');
	});

	it('uses the most used saturated colour when the theme colour is white', () => {
		const signals = extractWebsiteSignals(
			'<meta name="theme-color" content="#ffffff">',
			'https://example.com/'
		);
		const proposal = proposeBrandKit(
			signals,
			countCssColors('#e11d48 #e11d48 #333333 #333333 #333333')
		);
		expect(proposal.primaryColor).toBe('#e11d48');
		expect(proposal.textColor).toBe('#333333');
	});

	it('proposes nothing it did not find', () => {
		const proposal = proposeBrandKit(extractWebsiteSignals('', 'https://example.com/'), []);
		expect(proposal).toMatchObject({
			primaryColor: null,
			secondaryColor: null,
			textColor: null,
			backgroundColor: null,
			swatches: [],
			companyName: null,
			logoCandidates: [],
		});
	});
});
