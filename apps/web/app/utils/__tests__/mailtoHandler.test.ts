import { describe, expect, it, vi } from 'vitest';
import { MAILTO_HANDLER_PATH, mailtoHandlerSupport, requestMailtoHandler } from '../mailtoHandler';

describe('mailtoHandlerSupport', () => {
	const register = () => {};

	it('is supported on an HTTPS page of a browser that has registerProtocolHandler', () => {
		expect(mailtoHandlerSupport({ isSecureContext: true, registerProtocolHandler: register })).toBe(
			'supported'
		);
	});

	it('needs HTTPS', () => {
		expect(
			mailtoHandlerSupport({ isSecureContext: false, registerProtocolHandler: register })
		).toBe('insecure');
	});

	it('is unsupported where the browser has no registerProtocolHandler', () => {
		expect(mailtoHandlerSupport({ isSecureContext: true })).toBe('unsupported');
		expect(mailtoHandlerSupport({ isSecureContext: false })).toBe('unsupported');
	});
});

describe('requestMailtoHandler', () => {
	it('registers the compose route on this origin for mailto', () => {
		const registerProtocolHandler = vi.fn();
		expect(requestMailtoHandler({ registerProtocolHandler }, 'https://mail.example.com')).toBe(
			true
		);
		expect(registerProtocolHandler).toHaveBeenCalledWith(
			'mailto',
			'https://mail.example.com/dashboard/compose?mailto=%s'
		);
		expect(MAILTO_HANDLER_PATH).toContain('%s');
	});

	it('reports a refusal the browser throws', () => {
		const registerProtocolHandler = vi.fn(() => {
			throw new DOMException('The scheme or URL is not allowed.', 'SecurityError');
		});
		expect(requestMailtoHandler({ registerProtocolHandler }, 'https://mail.example.com')).toBe(
			false
		);
	});
});
