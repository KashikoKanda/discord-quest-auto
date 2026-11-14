import {
	addLog,
	getGlobalState,
	isResponseCompleted,
	readProgressValue,
	sleep,
	updateQuestProgress,
} from '../core/state';
import { enqueueApiCall } from '../core/queue';
import { getQuestType, getVideoSecondsNeeded } from './quest';

export async function doWatchVideoQuest(tokenId: string, quest: Record<string, unknown>): Promise<void> {
	const questId = quest.id as string;
	const questType = getQuestType(quest);
	const secondsNeeded = getVideoSecondsNeeded(quest);

	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	const enrolledAt = userStatus?.enrolled_at ? new Date(userStatus.enrolled_at as string).getTime() : Date.now();

	// aiko: REAL-TIME MODE — gửi timestamp theo thời gian thực để tránh revoke
	// Trước: speed=6, interval=6 → timestamp đi nhanh hơn real time → Discord detect bot
	// Sau: speed=5, interval=5 → 1:1 với real time (5s progress / 5s real)
	// KHÔNG tăng maxFuture quá cao — Discord check timestamp hợp lệ
	const maxFuture = 3; // giảm buffer để timestamp không đi quá xa
	const speed = 5;
	const interval = 5;
	let secondsDone: number = userStatus?.progress
		? (((userStatus.progress as Record<string, unknown>)[questType] as { value?: number } | undefined)?.value ?? 0)
		: 0;

	const config = quest.config as Record<string, unknown> | undefined;
	const questName =
		(config?.messages as Record<string, string>)?.quest_name ||
		(config?.messages as Record<string, string>)?.game_title ||
		questId;

	addLog(tokenId, 'info', `Bắt đầu quest Video: ${questName} (${secondsNeeded}s, đã xem ${secondsDone}s)`);
	updateQuestProgress(tokenId, questId, (secondsDone / secondsNeeded) * 100, 'running');

	let completed = false;

	while (true) {
		const state = getGlobalState().get(tokenId);
		if (!state || state.status !== 'running') {
			addLog(tokenId, 'warn', `Quest ${questName} đã dừng`);
			return;
		}

		const ctrl = state.abortControllers.get(questId);
		if (ctrl?.signal.aborted) {
			addLog(tokenId, 'warn', `Quest ${questName} bị abort`);
			updateQuestProgress(tokenId, questId, (secondsDone / secondsNeeded) * 100, 'paused');
			return;
		}

		const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
		const diff = maxAllowed - secondsDone;
		const timestamp = secondsDone + speed;

		if (diff >= speed) {
			try {
				// aiko: timestamp + Math.random() for natural variation
				const sendTimestamp = Math.min(secondsNeeded, timestamp + Math.random());
				const result = await enqueueApiCall(tokenId, `/quests/${questId}/video-progress`, {
					timestamp: sendTimestamp,
				});

				if (result.status === 401) {
					addLog(tokenId, 'error', `Token hết hạn khi gửi video-progress cho quest ${questName}`);
					state.status = 'error';
					return;
				}

				// completed_at is at ROOT level of response
				completed = isResponseCompleted(result.data);
				secondsDone = Math.min(secondsNeeded, timestamp);

				// Read actual progress from API response
				const apiProgress = readProgressValue(result.data, questType);
				if (apiProgress !== null) {
					secondsDone = apiProgress;
				}

				const progressPct = Math.min(100, (secondsDone / secondsNeeded) * 100);
				updateQuestProgress(tokenId, questId, progressPct, 'running');
				addLog(
					tokenId,
					'info',
					`Quest ${questName}: ${Math.round(secondsDone)}/${secondsNeeded}s (${Math.round(progressPct)}%)`,
				);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				addLog(tokenId, 'error', `Lỗi video quest ${questName}: ${msg}`);
			}
		}

		// Check if done
		if (timestamp >= secondsNeeded) {
			break;
		}

		await sleep(interval * 1000);
	}

	// aiko: If not completed after loop, send final video-progress with secondsNeeded
	if (!completed) {
		try {
			await enqueueApiCall(tokenId, `/quests/${questId}/video-progress`, {
				timestamp: secondsNeeded,
			});
		} catch {
			/* ignore */
		}
	}

	updateQuestProgress(tokenId, questId, 100, 'completed');
	addLog(tokenId, 'success', `Quest Video ${questName} hoàn thành!`);
	// Delay nhẹ 1s để UI load hoàn thành trước khi chuyển quest tiếp theo
	await sleep(1000);
}

// aiko: while(!completed) loop, reads progress from API response each heartbeat
