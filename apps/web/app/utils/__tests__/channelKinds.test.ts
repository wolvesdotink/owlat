import { describe, it, expect } from 'vitest';
import { ADDABLE_CHANNEL_KINDS, availableChannelKinds, channelHealthDot } from '../channelKinds';

describe('ADDABLE_CHANNEL_KINDS', () => {
	it('excludes the built-in email and chat kinds', () => {
		const kinds = ADDABLE_CHANNEL_KINDS.map((c) => c.kind);
		expect(kinds).not.toContain('email');
		expect(kinds).not.toContain('chat');
	});

	it('offers exactly the external messaging channels', () => {
		expect(ADDABLE_CHANNEL_KINDS.map((c) => c.kind)).toEqual(['sms', 'whatsapp', 'generic']);
	});
});

describe('availableChannelKinds', () => {
	it('returns all addable kinds when none are configured', () => {
		expect(availableChannelKinds([]).map((c) => c.kind)).toEqual(['sms', 'whatsapp', 'generic']);
	});

	it('filters out kinds that already have a config row', () => {
		const existing = [{ channel: 'sms' }, { channel: 'email' }];
		expect(availableChannelKinds(existing).map((c) => c.kind)).toEqual(['whatsapp', 'generic']);
	});

	it('never offers email or chat even when an email/chat row exists', () => {
		const existing = [{ channel: 'chat' }];
		const kinds = availableChannelKinds(existing).map((c) => c.kind);
		expect(kinds).not.toContain('email');
		expect(kinds).not.toContain('chat');
	});
});

describe('channelHealthDot', () => {
	it('maps healthy → success, degraded → warning, down → error', () => {
		expect(channelHealthDot('healthy').variant).toBe('success');
		expect(channelHealthDot('degraded').variant).toBe('warning');
		expect(channelHealthDot('down').variant).toBe('error');
	});

	it('treats an absent status as healthy', () => {
		expect(channelHealthDot(undefined).variant).toBe('success');
		expect(channelHealthDot(null).variant).toBe('success');
	});

	it('uses design-token dot classes and human labels (no enum strings)', () => {
		expect(channelHealthDot('down').dotClass).toBe('bg-error');
		expect(channelHealthDot('down').label).toBe('Down');
		expect(channelHealthDot('degraded').dotClass).toBe('bg-warning');
		expect(channelHealthDot('healthy').dotClass).toBe('bg-success');
	});
});
