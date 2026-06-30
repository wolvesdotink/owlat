import { describe, it, expect } from 'vitest';
import { renderButtonContent } from '../index';
import type { ButtonBlockContent } from '@owlat/shared';

describe('renderButtonContent', () => {
	it('renders bulletproof button', () => {
		const content: ButtonBlockContent = {
			text: 'Click Me',
			url: 'https://example.com',
			backgroundColor: '#007bff',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 4,
			paddingX: 24,
			paddingY: 12,
		};
		const result = renderButtonContent(content);
		expect(result).toContain('Click Me');
		expect(result).toContain('href="https://example.com"');
		expect(result).toContain('background-color:#007bff');
		expect(result).toContain('color:#ffffff');
		expect(result).toContain('border-radius:4px');
		expect(result).toContain('text-decoration:none');
		expect(result).toContain('align="center"');
	});

	it('includes mso-padding-alt on td', () => {
		const content: ButtonBlockContent = {
			text: 'Click',
			url: 'https://example.com',
			backgroundColor: '#007bff',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 4,
			paddingX: 24,
			paddingY: 12,
		};
		const result = renderButtonContent(content);
		expect(result).toContain('mso-padding-alt:12px 24px');
	});

	it('uses full width for full alignment', () => {
		const content: ButtonBlockContent = {
			text: 'Full Width',
			url: 'https://example.com',
			backgroundColor: '#007bff',
			textColor: '#ffffff',
			align: 'full',
			borderRadius: 0,
			paddingX: 24,
			paddingY: 12,
		};
		const result = renderButtonContent(content);
		expect(result).toContain('width="100%"');
		expect(result).toContain('width:100%');
		expect(result).toContain('display:block');
		expect(result).not.toContain('display:inline-block');
	});

	it('uses inline-block for non-full alignment', () => {
		const content: ButtonBlockContent = {
			text: 'Normal',
			url: 'https://example.com',
			backgroundColor: '#007bff',
			textColor: '#ffffff',
			align: 'center',
			borderRadius: 4,
			paddingX: 24,
			paddingY: 12,
		};
		const result = renderButtonContent(content);
		expect(result).toContain('display:inline-block');
	});
});
