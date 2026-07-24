import type { DispatchEffect } from './effects.js';
import type { OutcomeReduction } from './outcome.js';
import type { AttemptCtx } from './types.js';

/** Bind webhook provenance and isolate member previews from production effects. */
export function applyDeliveryDomainPolicy(
	reduction: OutcomeReduction,
	ctx: AttemptCtx
): OutcomeReduction {
	const deliveryDomain = ctx.job.deliveryDomain ?? 'production';
	const authenticatedEffects = reduction.effects.map(
		(effect): DispatchEffect =>
			effect.kind === 'notify_convex'
				? { ...effect, event: { ...effect.event, deliveryDomain } }
				: effect
	);
	if (deliveryDomain !== 'member_test') {
		return { ...reduction, effects: authenticatedEffects };
	}

	// A member preview uses the real SMTP transport and therefore retains the
	// immutable delivery log plus the Convex lifecycle callback. It must not
	// train or mutate any production suppression/reputation/routing state.
	return {
		...reduction,
		effects: authenticatedEffects.flatMap((effect): DispatchEffect[] => {
			if (effect.kind === 'log_delivery_event') return [effect];
			if (effect.kind !== 'notify_convex') return [];
			return [
				{
					...effect,
					event: {
						...effect.event,
						deliveryDomain: 'member_test',
						recipient: undefined,
						destinationProvider: undefined,
						primarySendingDomain: undefined,
					},
				},
			];
		}),
	};
}
