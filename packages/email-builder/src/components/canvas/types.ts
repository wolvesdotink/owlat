export type ParentContext =
	| { type: 'column'; parentId: string; columnIndex: number }
	| { type: 'container'; parentId: string };
