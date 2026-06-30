// Global type definitions for Owlat

export interface User {
	id: string;
	email: string;
	name: string | null;
	createdAt: Date;
}

export interface Team {
	id: string;
	name: string;
	createdAt: Date;
}

export interface TeamMember {
	id: string;
	userId: string;
	role: 'owner' | 'admin' | 'member';
	createdAt: Date;
}
