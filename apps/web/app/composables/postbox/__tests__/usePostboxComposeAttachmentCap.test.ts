import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	MAX_ATTACHMENT_BYTES,
	ATTACHMENT_COMPOSE_LIMITS,
} from '@owlat/shared/attachments';

/**
 * The composer's per-file attachment cap and its "max … MB" toast label must
 * track the shared MAX_ATTACHMENT_BYTES, not a hand-copied literal — otherwise
 * raising the shared cap leaves the composer rejecting at a stale size with a
 * stale label (the P1 drift this guards against).
 *
 * The cap lives inside the composable closure (it needs Nuxt/Convex context to
 * instantiate), so we assert against the module source: it must import the
 * shared constant and must NOT re-declare its own 25 MB literal / "25 MB" copy.
 */
const composeSrc = readFileSync(
	resolve(__dirname, '../usePostboxComposeAttachments.ts'),
	'utf8'
);

describe('usePostboxComposeAttachments attachment cap', () => {
	it('imports MAX_ATTACHMENT_BYTES from the shared attachments module', () => {
		expect(composeSrc).toMatch(
			/import\s*\{[^}]*\bMAX_ATTACHMENT_BYTES\b[^}]*\}\s*from\s*'@owlat\/shared\/attachments'/
		);
	});

	it('does not redeclare a local attachment-byte cap', () => {
		expect(composeSrc).not.toMatch(/(?:const|let|var)\s+MAX_ATTACHMENT_BYTES\s*=/);
	});

	it('derives the MB label from the shared cap instead of hardcoding "25 MB"', () => {
		expect(composeSrc).not.toContain('25 MB');
		expect(composeSrc).toMatch(/MAX_ATTACHMENT_BYTES\s*\/\s*1024\s*\/\s*1024/);
	});

	it('the shared cap the composer uses yields a clean whole-MB label', () => {
		const mb = MAX_ATTACHMENT_BYTES / 1024 / 1024;
		expect(Number.isInteger(mb)).toBe(true);
		expect(mb).toBeGreaterThan(0);
		// The per-file cap must be at least the combined per-message ceiling so a
		// single file is never rejected by the per-file gate before the total gate.
		expect(MAX_ATTACHMENT_BYTES).toBeGreaterThanOrEqual(
			ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
		);
	});
});
