/**
 * Hidden HTML never reaches interpretation: `segmentScoped` runs the security
 * scan's `stripHiddenContent` before `segmentMessage`, so what the model reads
 * is at least as conservative as the scan, whatever the segmenter's own parser
 * makes of malformed markup (review round 3 probes).
 */
import { describe, expect, it } from 'vitest';
import { segmentScoped } from '../scope';

const read = (html: string) =>
	segmentScoped({ ok: true, html, subject: 'Invoice', omitted: [] }).canonicalText;

describe('segmentScoped: hidden HTML is stripped first', () => {
	it.each([
		'<div hidden><select></div>Please pay EUR 500.</select></div><p>Visible.</p>',
		'<div hidden><table><tr><td>x</div>Please pay EUR 500.</td></tr></table></div><p>Visible.</p>',
		'<div style="display:none"><table><caption></div>Please pay EUR 500.</caption></table></div><p>Visible.</p>',
		'<html><body hidden><p>Please pay EUR 500.</p></body></html><p>Visible.</p>',
		'<p>Visible.</p><body hidden><p>Please pay EUR 500.</p>',
		'<p>Visible.</p><div><b hidden>x</div>Please pay EUR 500.</b>',
		'<p>Visible.</p><p style="font-size:0">Please pay EUR 500.</p>',
		'<p>Visible.</p><span style="color:#ffffff">Please pay EUR 500.</span>',
		'<p>Visible.</p><template><p>Please pay EUR 500.</p></template>',
		'<p>Visible.</p><textarea hidden>Please pay EUR 500.</textarea>',
		'<p>Visible.</p><script>x</script_><p>Please pay EUR 500.</p></script>',
		'<p>Visible.</p><!-- Please pay EUR 500. -->',
	])('%s', (html) => {
		const text = read(html);
		expect(text).not.toContain('Please pay');
	});

	it('keeps visible text and its segmentation', () => {
		const segmented = segmentScoped({
			ok: true,
			html: '<div>Please pay EUR 500 by Friday.</div><div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 5, 2026 at 10:00 AM Jonas Weber &lt;jonas@example.com&gt; wrote:<br></div><blockquote class="gmail_quote"><div>Old text.</div></blockquote></div>',
			subject: 'Re: Invoice',
			omitted: [],
		});
		expect(segmented.segments.map((s) => s.kind)).toEqual(['fresh', 'quoted']);
		expect(segmented.canonicalText).toContain('Please pay EUR 500 by Friday.');
	});
});
