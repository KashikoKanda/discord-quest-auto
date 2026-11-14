import type { QueueRequest } from './queue';

export interface QuestProgress {
	progress: number;
	status: string;
	startedAt: number;
	lastUpdated: number;
}

export interface TokenState {
	token: string;
	status: 'idle' | 'running' | 'error';
	isVerified: boolean;
	questProgress: Map<string, QuestProgress>;
	logs: Array<{ level: string; message: string; timestamp: number }>;
	intervals: Array<NodeJS.Timeout>;
	abortControllers: Map<string, AbortController>;
	apiQueue: QueueRequest[];
	queueProcessing: boolean;
	autoQuestEnabled: boolean;
	autoQuestLoopTimer?: NodeJS.Timeout;
	autoQuestLoopRunning?: boolean;
}

declare global {
	var questWorkerState: Map<string, TokenState> | undefined;
}

export function getGlobalState(): Map<string, TokenState> {
	if (!globalThis.questWorkerState) {
		globalThis.questWorkerState = new Map();
	}
	return globalThis.questWorkerState;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rnd(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Discord answers with `{ progress: { PLAY_ON_DESKTOP: { value: 900 } } }`.
 * Returns null when the type is absent, so callers keep their own estimate.
 */
export function readProgressValue(data: any, questType: string): number | null {
	if (!data || typeof data !== 'object') return null;
	const progress = data.progress;
	if (!progress || typeof progress !== 'object') return null;
	const taskProg = progress[questType];
	if (!taskProg || typeof taskProg !== 'object') return null;
	return typeof taskProg.value === 'number' ? taskProg.value : null;
}

/** `completed_at` sits at the root of the response, not under user_status. */
export function isResponseCompleted(data: any): boolean {
	return data?.completed_at != null;
}

export function addLog(tokenId: string, level: string, message: string): void {
	const state = getGlobalState().get(tokenId);
	if (state) {
		// Ghi vào cuối (cũ → mới). tail() và /run đều đọc theo chỉ số tăng dần;
		// unshift trước đây làm mỗi lần thêm log xô lệch chỉ số khiến tin nhắn /run
		// in lại các dòng cũ và không bao giờ tới được dòng mới.
		state.logs.push({ level, message, timestamp: Date.now() });
		if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
	}
}

export function updateQuestProgress(tokenId: string, questId: string, progress: number, status: string): void {
	const state = getGlobalState().get(tokenId);
	if (state) {
		state.questProgress.set(questId, {
			progress,
			status,
			startedAt: state.questProgress.get(questId)?.startedAt || Date.now(),
			lastUpdated: Date.now(),
		});
	}
}

export function clearAllIntervals(tokenId: string): void {
	const state = getGlobalState().get(tokenId);
	if (!state) return;
	for (const interval of state.intervals) {
		clearInterval(interval);
	}
	state.intervals = [];
	for (const [, ctrl] of state.abortControllers) {
		ctrl.abort();
	}
	state.abortControllers.clear();
}
