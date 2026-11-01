import { ShareIcon } from '@coolicons/vue';
import type { EditorModule } from '../_module';
import { socialSchema } from '../../schema/definitions/social';

export const socialEditor: EditorModule<'social'> = {
	type: 'social',
	label: 'Social',
	icon: ShareIcon,
	schema: socialSchema,
	slashCommand: {
		name: 'Social Icons',
		description: 'Social media links',
		category: 'components',
		aliases: ['socials', 'twitter', 'facebook', 'instagram'],
	},
	canBeInColumn: false,
	canBeInContainer: true,
};
