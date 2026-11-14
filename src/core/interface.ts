export type QuestTaskType =
	| 'WATCH_VIDEO'
	| 'WATCH_VIDEO_ON_MOBILE'
	| 'PLAY_ON_DESKTOP'
	| 'PLAY_ON_XBOX'
	| 'PLAY_ON_PLAYSTATION'
	| 'STREAM_ON_DESKTOP'
	| 'PLAY_ACTIVITY'
	| 'ACHIEVEMENT_IN_ACTIVITY'
	| 'UNKNOWN';

export interface QuestUserStatus {
	enrolled_at?: string | null;
	completed_at?: string | null;
	claimed_at?: string | null;
	progress?: Record<string, number> | null;
}

export interface QuestTaskConfig {
	tasks?: Record<string, Record<string, unknown>>;
	expires_at?: string;
	[key: string]: unknown;
}

export interface QuestConfig {
	messages?: {
		quest_name?: string;
		game_title?: string;
		[key: string]: unknown;
	};
	assets?: Record<string, unknown>;
	colors?: Record<string, unknown>;
	rewards_config?: {
		rewards?: Array<{
			type?: number;
			messages?: { name?: string; [key: string]: unknown };
			orb_quantity?: number;
			[key: string]: unknown;
		}>;
		[key: string]: unknown;
	};
	task_config_v2?: QuestTaskConfig;
	application?: { id?: string; [key: string]: unknown };
	expires_at?: string;
	[key: string]: unknown;
}

/** One quest as returned by `GET /quests/@me`. */
export interface QuestShape {
	id: string;
	config?: QuestConfig;
	user_status?: QuestUserStatus;
	preview?: boolean;
	[key: string]: unknown;
}

export interface QuestListResponse {
	quests: QuestShape[];
	excludedQuests: QuestShape[];
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
	level: LogLevel | string;
	message: string;
	timestamp: number;
}

export type Command = 'run' | 'list' | 'hidden' | 'claim' | 'auto' | 'status' | 'stop' | 'help';

export interface TokenSession {
	token: string;
	tokenId: string;
	user: Record<string, unknown> & { username: string; id: string };
	isVerified: boolean;
	invite: string;
}
