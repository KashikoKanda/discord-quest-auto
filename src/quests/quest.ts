import type { QuestShape, QuestTaskType } from '../core/interface';

export function getQuestType(quest: QuestShape | Record<string, unknown>): QuestTaskType {
	const q = quest as QuestShape;
	const tasks = q.config?.task_config_v2 as Record<string, unknown> | undefined;
	const taskMap = tasks?.tasks as Record<string, unknown> | undefined;
	if (!taskMap) return 'UNKNOWN';
	const types = [
		'WATCH_VIDEO',
		'WATCH_VIDEO_ON_MOBILE',
		'PLAY_ON_DESKTOP',
		'PLAY_ON_XBOX',
		'PLAY_ON_PLAYSTATION',
		'STREAM_ON_DESKTOP',
		'PLAY_ACTIVITY',
		'ACHIEVEMENT_IN_ACTIVITY',
	];
	for (const t of types) {
		if (taskMap[t] != null) return t as QuestTaskType;
	}
	return 'UNKNOWN';
}

export function getVideoSecondsNeeded(quest: Record<string, unknown>): number {
	const tasks = ((quest.config as Record<string, unknown>)?.task_config_v2 as Record<string, unknown>)?.tasks as
		Record<string, unknown> | undefined;
	if (!tasks) return 900;
	const watchVideo = tasks.WATCH_VIDEO || tasks.WATCH_VIDEO_ON_MOBILE;
	// API returns "target" in seconds (v2), fallback to seconds_needed (v1)
	const target = (watchVideo as Record<string, unknown>)?.target as number | undefined;
	if (target) return target;
	return ((watchVideo as Record<string, unknown>)?.seconds_needed as number) || 900;
}

export function getPlayDurationNeeded(quest: Record<string, unknown>): number {
	const tasks = ((quest.config as Record<string, unknown>)?.task_config_v2 as Record<string, unknown>)?.tasks as
		Record<string, unknown> | undefined;
	if (!tasks) return 900;
	const playTask =
		tasks.PLAY_ON_DESKTOP ||
		tasks.PLAY_ON_XBOX ||
		tasks.PLAY_ON_PLAYSTATION ||
		tasks.PLAY_ACTIVITY ||
		tasks.ACHIEVEMENT_IN_ACTIVITY;
	// API returns "target" in seconds (v2), fallback to minutes_needed (v1)
	const target = (playTask as Record<string, unknown>)?.target as number | undefined;
	if (target) return target;
	const minutesNeeded = (playTask as Record<string, unknown>)?.minutes_needed as number | undefined;
	return minutesNeeded ? minutesNeeded * 60 : 900;
}

export function getApplicationId(quest: Record<string, unknown>): string | null {
	const tasks = ((quest.config as Record<string, unknown>)?.task_config_v2 as Record<string, unknown>)?.tasks as
		Record<string, unknown> | undefined;
	if (!tasks) return ((quest.config as Record<string, unknown>)?.content_id as string) || null;
	const playTask = tasks.PLAY_ON_DESKTOP || tasks.PLAY_ON_XBOX || tasks.PLAY_ON_PLAYSTATION;
	// v2 uses "applications" array with {id: "..."}, v1 uses "application_id" string
	const apps = (playTask as Record<string, unknown>)?.applications as Array<Record<string, unknown>> | undefined;
	if (apps && apps.length > 0 && apps[0].id) return apps[0].id as string;
	return (
		((playTask as Record<string, unknown>)?.application_id as string) ||
		((quest.config as Record<string, unknown>)?.content_id as string) ||
		null
	);
}

export function isQuestCompleted(quest: Record<string, unknown>): boolean {
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	return userStatus?.completed_at != null;
}

export function isQuestExpired(quest: Record<string, unknown>): boolean {
	const config = quest.config as Record<string, unknown> | undefined;
	const expiresAt = config?.expires_at as string | undefined;
	if (!expiresAt) return false;
	return new Date(expiresAt).getTime() < Date.now();
}

export function isQuestClaimed(quest: Record<string, unknown>): boolean {
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	return userStatus?.claimed_at != null;
}

export function getQuestMessages(quest: Record<string, unknown>): {
	questName: string;
	gameTitle: string;
	gamePublisher: string;
} {
	const config = quest.config as Record<string, unknown> | undefined;
	const messages = config?.messages as Record<string, string> | undefined;
	return {
		questName: messages?.quest_name || (config?.quest_id as string) || `Quest ${(quest.id as string)?.slice(0, 8)}`,
		gameTitle: messages?.game_title || '',
		gamePublisher: messages?.game_publisher || '',
	};
}

export function getQuestColors(quest: Record<string, unknown>): {
	primary: string;
	secondary: string;
} {
	const config = quest.config as Record<string, unknown> | undefined;
	const colors = config?.colors as Record<string, string> | undefined;
	return {
		primary: colors?.primary || '#5865F2',
		secondary: colors?.secondary || '#1e2029',
	};
}

export function getQuestAssets(quest: Record<string, unknown>): {
	hero: string;
	gameTile: string;
	logotype: string;
	logotypeLight: string;
	logotypeDark: string;
} {
	const config = quest.config as Record<string, unknown> | undefined;
	const assets = config?.assets as Record<string, string> | undefined;
	// Discord API returns `logotype` (per aiko-chan-ai interface).
	// Some older quests may return `logotype_light`/`logotype_dark` variants —
	// fallback to `logotype` if the variant is missing so the logo still shows.
	const logotype = assets?.logotype || '';
	return {
		hero: assets?.hero || '',
		gameTile: assets?.game_tile || '',
		logotype,
		logotypeLight: assets?.logotype_light || logotype,
		logotypeDark: assets?.logotype_dark || logotype,
	};
}

export function buildBannerUrl(questId: string, heroAsset: string): string | undefined {
	if (!heroAsset) return undefined;
	if (heroAsset.includes('/')) {
		return `https://cdn.discordapp.com/${heroAsset}`;
	}
	return `https://cdn.discordapp.com/quests/${questId}/assets/${heroAsset}.webp`;
}

export function getOrbsReward(quest: Record<string, unknown>): number | null {
	const config = quest.config as Record<string, unknown> | undefined;
	const rewardsConfig = config?.rewards_config as Record<string, unknown> | undefined;
	const rewards = rewardsConfig?.rewards as Array<Record<string, unknown>> | undefined;
	if (!rewards || rewards.length === 0) return null;
	return (rewards[0].orb_quantity as number) || null;
}

export function calculateQuestProgress(quest: Record<string, unknown>): number {
	const questType = getQuestType(quest);
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	const raw = userStatus?.progress;

	if (raw == null) return 0;
	if (typeof raw === 'number') return raw;
	if (typeof raw === 'object' && raw !== null) {
		const taskProgress = (raw as Record<string, unknown>)[questType] as Record<string, unknown> | undefined;
		if (taskProgress?.completed_at) return 100;
		if (taskProgress?.value != null) {
			const value = taskProgress.value as number;
			const isVideoType = questType.startsWith('WATCH_VIDEO') || questType === 'STREAM_ON_DESKTOP';
			const denominator = isVideoType ? getVideoSecondsNeeded(quest) : getPlayDurationNeeded(quest);
			if (denominator > 0) {
				return Math.min(100, Math.round((value / denominator) * 100));
			}
		}
		return 0;
	}
	return 0;
}

export class Quest {
	private constructor(private readonly data: QuestShape) {}

	static create(data: QuestShape): Quest {
		return new Quest(data);
	}

	get id(): string {
		return String(this.data.id ?? '');
	}

	get raw(): QuestShape {
		return this.data;
	}

	get config(): NonNullable<QuestShape['config']> {
		return this.data.config ?? {};
	}

	get userStatus(): QuestShape['user_status'] {
		return this.data.user_status;
	}

	get type(): QuestTaskType {
		return getQuestType(this.data);
	}

	get name(): string {
		return getQuestMessages(this.data).questName;
	}

	get progress(): number {
		return calculateQuestProgress(this.data);
	}

	get orbs(): number | null {
		return getOrbsReward(this.data);
	}

	get expiresAt(): string | null {
		return (this.config.expires_at as string) ?? null;
	}

	isExpired(): boolean {
		return isQuestExpired(this.data);
	}

	isCompleted(): boolean {
		return isQuestCompleted(this.data);
	}

	isClaimed(): boolean {
		return isQuestClaimed(this.data);
	}

	/** Còn việc để làm: chưa xong, chưa nhận thưởng, chưa hết hạn. */
	isOpen(): boolean {
		return !this.isCompleted() && !this.isClaimed() && !this.isExpired();
	}

	isEnrolled(): boolean {
		return Boolean(this.userStatus?.enrolled_at);
	}

	label(): string {
		if (this.isClaimed()) return 'đã nhận';
		if (this.isCompleted()) return 'chờ nhận';
		if (this.isEnrolled()) return 'đang làm';
		if (this.isExpired()) return 'hết hạn';
		return 'chưa nhận';
	}
}
