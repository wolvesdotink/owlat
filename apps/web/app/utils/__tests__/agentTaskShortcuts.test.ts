/**
 * The shared agent-task-card key vocabulary: 1–9 pick a chip, Enter submits,
 * s skips, e edits, Esc exits. Pure mapping — chord/editable-target filtering
 * is the caller's job.
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentTaskShortcut } from '../agentTaskShortcuts';

describe('resolveAgentTaskShortcut', () => {
	it('maps digits 1–9 to zero-based chip indexes', () => {
		expect(resolveAgentTaskShortcut('1')).toEqual({ type: 'chip', index: 0 });
		expect(resolveAgentTaskShortcut('5')).toEqual({ type: 'chip', index: 4 });
		expect(resolveAgentTaskShortcut('9')).toEqual({ type: 'chip', index: 8 });
	});

	it('never maps 0 or multi-character keys to a chip', () => {
		expect(resolveAgentTaskShortcut('0')).toBeNull();
		expect(resolveAgentTaskShortcut('10')).toBeNull();
		expect(resolveAgentTaskShortcut('F1')).toBeNull();
	});

	it('maps Enter/s/e/Escape to submit/skip/edit/exit', () => {
		expect(resolveAgentTaskShortcut('Enter')).toEqual({ type: 'submit' });
		expect(resolveAgentTaskShortcut('s')).toEqual({ type: 'skip' });
		expect(resolveAgentTaskShortcut('e')).toEqual({ type: 'edit' });
		expect(resolveAgentTaskShortcut('Escape')).toEqual({ type: 'exit' });
	});

	it('returns null for unmapped keys (they fall through to the surface vocabulary)', () => {
		expect(resolveAgentTaskShortcut('a')).toBeNull();
		expect(resolveAgentTaskShortcut('x')).toBeNull();
		expect(resolveAgentTaskShortcut('S')).toBeNull(); // shifted keys stay inert
	});
});
