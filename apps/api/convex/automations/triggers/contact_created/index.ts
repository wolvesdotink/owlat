import type {
	ContactCreatedFireInput,
	TriggerModule,
} from '../types';

export const contactCreatedTrigger: TriggerModule<
	'contact_created',
	null,
	ContactCreatedFireInput
> = {
	kind: 'contact_created',
	matches: () => true,
};
