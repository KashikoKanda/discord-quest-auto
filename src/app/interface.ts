export type CommandName =
	'help' | 'link' | 'unlink' | 'quests' | 'hidden' | 'proxy' | 'run' | 'stop' | 'claim' | 'status' | 'auto';

export interface CommandOption {
	name: string;
	type: number;
	value: string | number | boolean;
}

export interface GatewayInteraction {
	id: string;
	application_id: string;
	token: string;
	type: number;
	guild_id?: string;
	channel_id?: string;
	member?: { user: { id: string; username: string } };
	user?: { id: string; username: string };
	data?: {
		name?: string;
		custom_id?: string;
		options?: CommandOption[];
		components?: Array<{ components: Array<{ custom_id: string; value: string }> }>;
		/** Giá trị đã chọn trong menu chọn (component type 3). */
		values?: string[];
	};
}
