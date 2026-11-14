import { addLog, getGlobalState, readProgressValue, sleep, updateQuestProgress } from '../core/state';
import { enqueueApiCall } from '../core/queue';
import { getApplicationId, getPlayDurationNeeded, getQuestType, isQuestCompleted } from './quest';

export async function doPlayOnDesktopQuest(tokenId: string, quest: Record<string, unknown>): Promise<void> {
	const questId = quest.id as string;
	const questType = getQuestType(quest);
	const appId = getApplicationId(quest);
	const totalDuration = getPlayDurationNeeded(quest);
	// Heartbeat interval — 30s (real Discord client gửi mỗi 30s)
	// Trước: 15s → quá nhanh → Discord detect bot → revoke token
	// Sau: 30s → giống Discord client thật
	const heartbeatInterval = 30;

	const config = quest.config as Record<string, unknown> | undefined;
	const questName =
		(config?.messages as Record<string, string>)?.quest_name ||
		(config?.messages as Record<string, string>)?.game_title ||
		questId;
	const applicationName = ((config?.application as Record<string, unknown>)?.name as string) || appId || 'unknown';

	// Read existing progress from quest data
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	let elapsed: number = userStatus?.progress
		? (((userStatus.progress as Record<string, unknown>)[questType] as { value?: number } | undefined)?.value ?? 0)
		: 0;

	addLog(
		tokenId,
		'info',
		`Bắt đầu quest Play: ${questName} (${Math.floor(totalDuration / 60)} phút, app: ${applicationName}, đã chơi ${elapsed}s)`,
	);
	updateQuestProgress(tokenId, questId, (elapsed / totalDuration) * 100, 'running');

	// aiko: while(!quest.isCompleted()) loop with heartbeat
	let completed = isQuestCompleted(quest);

	while (!completed) {
		const state = getGlobalState().get(tokenId);
		if (!state || state.status !== 'running') {
			addLog(tokenId, 'warn', `Quest ${questName} đã dừng`);
			return;
		}

		const ctrl = state.abortControllers.get(questId);
		if (ctrl?.signal.aborted) {
			updateQuestProgress(tokenId, questId, (elapsed / totalDuration) * 100, 'paused');
			return;
		}

		try {
			// Read current progress from quest data (updated each heartbeat)
			const currentProgress = userStatus?.progress
				? (((userStatus.progress as Record<string, unknown>)[questType] as { value?: number } | undefined)
						?.value ?? 0)
				: 0;

			// Send heartbeat with application_id (aiko-style)
			const body: Record<string, unknown> = {
				application_id: appId,
				terminal: false,
			};

			const result = await enqueueApiCall(tokenId, `/quests/${questId}/heartbeat`, body);

			if (result.status === 401) {
				addLog(tokenId, 'error', `Token hết hạn khi gửi heartbeat cho quest ${questName}`);
				state.status = 'error';
				return;
			}

			// Update quest status from API response (aiko: quest.updateUserStatus(res))
			const apiProgress = readProgressValue(result.data, questType);
			if (apiProgress !== null) {
				elapsed = apiProgress;
			} else {
				elapsed = currentProgress + heartbeatInterval;
			}

			// Update userStatus progress from API response for next iteration
			if (result.data?.progress) {
				try {
					(quest.user_status as Record<string, unknown>)!.progress = result.data.progress;
				} catch {
					/* ignore */
				}
			}
			if (result.data?.completed_at) {
				completed = true;
			}

			const progressPct = Math.min(100, (elapsed / totalDuration) * 100);
			updateQuestProgress(tokenId, questId, progressPct, 'running');

			addLog(
				tokenId,
				'info',
				`Quest ${questName}: Đang giả lập ${applicationName}. Còn ${Math.ceil((totalDuration - elapsed) / 60)} phút.`,
			);

			await sleep(heartbeatInterval * 1000);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			addLog(tokenId, 'error', `Lỗi play quest ${questName}: ${msg}`);
			await sleep(5000);
		}
	}

	// aiko: Send terminal heartbeat after completion
	try {
		const terminalBody: Record<string, unknown> = {
			application_id: appId,
			terminal: true,
		};
		await enqueueApiCall(tokenId, `/quests/${questId}/heartbeat`, terminalBody);
	} catch {
		/* ignore */
	}

	updateQuestProgress(tokenId, questId, 100, 'completed');
	addLog(tokenId, 'success', `Quest Play ${questName} hoàn thành!`);
	// Delay nhẹ 1s để UI load hoàn thành trước khi chuyển quest tiếp theo
	await sleep(1000);
}
