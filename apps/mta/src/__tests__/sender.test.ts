import { describe, it, expect } from 'vitest';

// Test the pure helper functions extracted from sender.ts
// These are not exported, so we test the patterns directly

describe('parseEnhancedCode pattern', () => {
	const parseEnhancedCode = (response: string): string | undefined => {
		const match = response.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/);
		return match?.[1];
	};

	it('should extract 5.1.1 from standard bounce', () => {
		expect(parseEnhancedCode('550 5.1.1 User unknown')).toBe('5.1.1');
	});

	it('should extract 5.2.2 from mailbox full', () => {
		expect(parseEnhancedCode('552 5.2.2 Quota exceeded')).toBe('5.2.2');
	});

	it('should extract 4.7.0 from rate limit', () => {
		expect(parseEnhancedCode('421 4.7.0 Too many connections')).toBe('4.7.0');
	});

	it('should extract 2.0.0 from success', () => {
		expect(parseEnhancedCode('250 2.0.0 OK')).toBe('2.0.0');
	});

	it('should handle multi-digit sub-codes', () => {
		expect(parseEnhancedCode('550 5.11.22 Custom error')).toBe('5.11.22');
	});

	it('should return undefined for responses without enhanced codes', () => {
		expect(parseEnhancedCode('550 User unknown')).toBeUndefined();
		expect(parseEnhancedCode('Connection refused')).toBeUndefined();
	});

	it('should not match invalid class digits', () => {
		expect(parseEnhancedCode('550 3.1.1 Invalid')).toBeUndefined();
		expect(parseEnhancedCode('550 6.1.1 Invalid')).toBeUndefined();
	});
});

describe('stripHtml pattern', () => {
	const stripHtml = (html: string): string => {
		return html
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<\/div>/gi, '\n')
			.replace(/<\/h[1-6]>/gi, '\n\n')
			.replace(/<\/li>/gi, '\n')
			.replace(/<\/tr>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&#039;/gi, "'")
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	};

	it('should strip HTML tags', () => {
		expect(stripHtml('<p>Hello <b>World</b></p>')).toBe('Hello World');
	});

	it('should convert <br> to newlines', () => {
		expect(stripHtml('Line 1<br>Line 2<br/>Line 3')).toBe('Line 1\nLine 2\nLine 3');
	});

	it('should decode HTML entities', () => {
		expect(stripHtml('&amp; &lt; &gt; &quot; &#039;')).toBe('& < > " \'');
	});

	it('should remove style blocks', () => {
		expect(stripHtml('<style>body{color:red}</style>Hello')).toBe('Hello');
	});

	it('should remove script blocks', () => {
		expect(stripHtml('<script>alert("xss")</script>Hello')).toBe('Hello');
	});

	it('should collapse multiple newlines', () => {
		expect(stripHtml('<p>A</p><p>B</p><p>C</p>')).toBe('A\n\nB\n\nC');
	});

	it('should convert &nbsp; to spaces', () => {
		expect(stripHtml('Hello&nbsp;World')).toBe('Hello World');
	});

	it('should handle empty input', () => {
		expect(stripHtml('')).toBe('');
	});
});
