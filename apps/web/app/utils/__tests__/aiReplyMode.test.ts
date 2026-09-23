import { describe, expect, it } from 'vitest';
import { deriveAiReplyMode, planAiReplyModeChange, type AiReplySettings } from '../aiReplyMode';

const settings = (overrides: Partial<AiReplySettings> = {}): AiReplySettings => ({
	agentEnabled: true,
	rulesEnabled: false,
	config: null,
	...overrides,
});

describe('deriveAiReplyMode', () => {
	it('is Off whenever the agent flag is off, whatever else is set', () => {
		expect(
			deriveAiReplyMode(
				settings({
					agentEnabled: false,
					rulesEnabled: true,
					config: { isAutoReplyEnabled: true, isShadowMode: false },
				})
			)
		).toBe('off');
	});

	it('defaults to Draft only with no config row', () => {
		expect(deriveAiReplyMode(settings())).toBe('draft');
	});

	it('reads an old "Auto-reply on" as Draft only while shadow mode is unset — nothing sent then', () => {
		expect(deriveAiReplyMode(settings({ config: { isAutoReplyEnabled: true } }))).toBe('draft');
		expect(
			deriveAiReplyMode(settings({ config: { isAutoReplyEnabled: true, isShadowMode: true } }))
		).toBe('draft');
	});

	it('is Send automatically only when shadow is off and a send tier is armed', () => {
		expect(
			deriveAiReplyMode(settings({ config: { isAutoReplyEnabled: true, isShadowMode: false } }))
		).toBe('auto');
		// Per-category rules arm sending on their own.
		expect(
			deriveAiReplyMode(
				settings({
					rulesEnabled: true,
					config: { isAutoReplyEnabled: false, isShadowMode: false },
				})
			)
		).toBe('auto');
		// Shadow off with no tier armed still sends nothing.
		expect(
			deriveAiReplyMode(settings({ config: { isAutoReplyEnabled: false, isShadowMode: false } }))
		).toBe('draft');
	});
});

describe('planAiReplyModeChange', () => {
	it('does nothing when the target is already in force', () => {
		expect(planAiReplyModeChange(settings(), 'draft')).toEqual([]);
		expect(planAiReplyModeChange(settings({ agentEnabled: false }), 'off')).toEqual([]);
	});

	it('arms sending on a running agent in one write', () => {
		expect(planAiReplyModeChange(settings(), 'auto')).toEqual([
			{ kind: 'replyMode', mode: 'auto' },
		]);
	});

	it('stops sending before turning the agent off, so coming back lands on Draft only', () => {
		const auto = settings({ config: { isAutoReplyEnabled: true, isShadowMode: false } });
		expect(planAiReplyModeChange(auto, 'off')).toEqual([
			{ kind: 'replyMode', mode: 'draft' },
			{ kind: 'agentFlag', value: false },
		]);
	});

	it('turns the agent on before setting the send mode', () => {
		const off = settings({ agentEnabled: false });
		expect(planAiReplyModeChange(off, 'draft')).toEqual([
			{ kind: 'agentFlag', value: true },
			{ kind: 'replyMode', mode: 'draft' },
		]);
		expect(planAiReplyModeChange(off, 'auto')).toEqual([
			{ kind: 'agentFlag', value: true },
			{ kind: 'replyMode', mode: 'auto' },
		]);
	});

	it('Draft only from auto disarms sending without touching the agent flag', () => {
		const auto = settings({ config: { isAutoReplyEnabled: true, isShadowMode: false } });
		expect(planAiReplyModeChange(auto, 'draft')).toEqual([{ kind: 'replyMode', mode: 'draft' }]);
	});
});
