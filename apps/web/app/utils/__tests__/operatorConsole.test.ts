import { describe, it, expect } from 'vitest';
import {
	abuseStatusVariant,
	isBlockingAbuseStatus,
	riskLevelVariant,
	scanLevelVariant,
	formatRate,
	auditActionLabel,
} from '../operatorConsole';

describe('abuseStatusVariant', () => {
	it('maps clean to success', () => {
		expect(abuseStatusVariant('clean')).toBe('success');
	});

	it('maps warned to warning', () => {
		expect(abuseStatusVariant('warned')).toBe('warning');
	});

	it('maps suspended and banned to error', () => {
		expect(abuseStatusVariant('suspended')).toBe('error');
		expect(abuseStatusVariant('banned')).toBe('error');
	});

	it('falls back to neutral for unknown/undefined', () => {
		expect(abuseStatusVariant(undefined)).toBe('neutral');
		expect(abuseStatusVariant('weird')).toBe('neutral');
	});
});

describe('isBlockingAbuseStatus', () => {
	it('is true for suspended and banned (sending blocked)', () => {
		expect(isBlockingAbuseStatus('suspended')).toBe(true);
		expect(isBlockingAbuseStatus('banned')).toBe(true);
	});

	it('is false for warned — soft auto-warn does not block sending', () => {
		expect(isBlockingAbuseStatus('warned')).toBe(false);
	});

	it('is false for clean and undefined', () => {
		expect(isBlockingAbuseStatus('clean')).toBe(false);
		expect(isBlockingAbuseStatus(undefined)).toBe(false);
	});
});

describe('riskLevelVariant', () => {
	it('maps levels to badge variants', () => {
		expect(riskLevelVariant('low')).toBe('success');
		expect(riskLevelVariant('medium')).toBe('warning');
		expect(riskLevelVariant('high')).toBe('error');
		expect(riskLevelVariant('critical')).toBe('error');
		expect(riskLevelVariant(undefined)).toBe('neutral');
	});
});

describe('scanLevelVariant', () => {
	it('maps scan levels to badge variants', () => {
		expect(scanLevelVariant('safe')).toBe('success');
		expect(scanLevelVariant('suspicious')).toBe('warning');
		expect(scanLevelVariant('blocked')).toBe('error');
		expect(scanLevelVariant('???')).toBe('neutral');
	});
});

describe('formatRate', () => {
	it('formats a 0-1 rate as a percentage', () => {
		expect(formatRate(0.0123)).toBe('1.23%');
		expect(formatRate(0)).toBe('0.00%');
		expect(formatRate(1)).toBe('100.00%');
	});

	it('returns a dash for undefined or NaN', () => {
		expect(formatRate(undefined)).toBe('—');
		expect(formatRate(Number.NaN)).toBe('—');
	});
});

describe('auditActionLabel', () => {
	it('humanizes known platform-admin actions', () => {
		expect(auditActionLabel('platform_admin.content_approved')).toBe('Approved content');
		expect(auditActionLabel('platform_admin.content_rejected')).toBe('Rejected content');
		expect(auditActionLabel('platform_admin.org_status_changed')).toBe('Changed org status');
		expect(auditActionLabel('platform_admin.admin_added')).toBe('Added admin');
		expect(auditActionLabel('platform_admin.admin_removed')).toBe('Removed admin');
	});

	it('echoes unknown actions unchanged and handles undefined', () => {
		expect(auditActionLabel('something.else')).toBe('something.else');
		expect(auditActionLabel(undefined)).toBe('Unknown action');
	});
});
