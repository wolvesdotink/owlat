import { GalleryHorizontal } from '@lucide/vue';
import type { EditorModule } from '../_module';
import { carouselSchema } from '../../schema/definitions/carousel';

export const carouselEditor: EditorModule<'carousel'> = {
	type: 'carousel',
	label: 'Carousel',
	icon: GalleryHorizontal,
	schema: carouselSchema,
	slashCommand: {
		name: 'Carousel',
		description: 'Image carousel / slider',
		category: 'media',
		aliases: ['slider', 'gallery', 'slideshow'],
	},
	canBeInColumn: false,
	canBeInContainer: false,
	supportsBorderRadius: true,
};
