import { Image as ImageIcon } from '@lucide/vue';
import type { EditorModule } from '../_module';
import type { ImageBlockContent } from '../../types';
import { imageSchema } from '../../schema/definitions/image';

export const imageEditor: EditorModule<'image'> = {
	type: 'image',
	label: 'Image',
	icon: ImageIcon,
	schema: imageSchema,
	slashCommand: {
		name: 'Image',
		description: 'Upload or embed an image',
		category: 'media',
		aliases: ['img', 'picture', 'photo'],
	},
	canBeInColumn: true,
	canBeInContainer: true,
	supportsBorderRadius: true,
	createDefaultColumnItem: () =>
		({
			src: '',
			alt: '',
			width: 100,
			align: 'center',
			storageId: undefined,
			linkUrl: undefined,
		}) as ImageBlockContent,
};
