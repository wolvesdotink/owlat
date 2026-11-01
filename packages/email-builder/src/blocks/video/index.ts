import { PlayIcon } from '@coolicons/vue';
import type { EditorModule } from '../_module';
import { videoSchema } from '../../schema/definitions/video';

export const videoEditor: EditorModule<'video'> = {
	type: 'video',
	label: 'Video',
	icon: PlayIcon,
	schema: videoSchema,
	slashCommand: {
		name: 'Video',
		description: 'Video thumbnail with play button',
		category: 'media',
		aliases: ['youtube', 'vimeo', 'embed'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
};
