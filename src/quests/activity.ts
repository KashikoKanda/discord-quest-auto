import { addLog, getGlobalState, readProgressValue, sleep, updateQuestProgress } from '../core/state';
import { enqueueApiCall } from '../core/queue';
import { getPlayDurationNeeded, getQuestType, isQuestCompleted } from './quest';

export async function doPlayActivityQuest(tokenId: string, quest: Record<string, unknown>): Promise<void> {
	const questId = quest.id as string;
	const questType = getQuestType(quest);
	const totalDuration = getPlayDurationNeeded(quest);
	// Heartbeat interval — 30s (giống Discord client thật)
	const heartbeatInterval = 30;
	const streamKey = 'call:1:1'; // aiko: call:1:1

	const config = quest.config as Record<string, unknown> | undefined;
	const questName =
		(config?.messages as Record<string, string>)?.quest_name ||
		(config?.messages as Record<string, string>)?.game_title ||
		questId;
	const applicationName = ((config?.application as Record<string, unknown>)?.name as string) || 'Activity';

	// Read existing progress
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	let elapsed: number = userStatus?.progress
		? (((userStatus.progress as Record<string, unknown>)[questType] as { value?: number } | undefined)?.value ?? 0)
		: 0;

	addLog(
		tokenId,
		'info',
		`Bắt đầu quest Activity: ${questName} (${Math.floor(totalDuration / 60)} phút, đã chơi ${elapsed}s)`,
	);
	updateQuestProgress(tokenId, questId, (elapsed / totalDuration) * 100, 'running');

	// aiko: while(!quest.isCompleted()) loop
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
			const currentProgress = userStatus?.progress
				? (((userStatus.progress as Record<string, unknown>)[questType] as { value?: number } | undefined)
						?.value ?? 0)
				: 0;

			const result = await enqueueApiCall(tokenId, `/quests/${questId}/heartbeat`, {
				stream_key: streamKey,
				terminal: false,
			});

			if (result.status === 401) {
				addLog(tokenId, 'error', `Token hết hạn khi gửi heartbeat cho quest ${questName}`);
				state.status = 'error';
				return;
			}

			// Update quest from API response (aiko: quest.updateUserStatus(res))
			const apiProgress = readProgressValue(result.data, questType);
			if (apiProgress !== null) {
				elapsed = apiProgress;
			} else {
				elapsed = currentProgress + heartbeatInterval;
			}

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
			addLog(tokenId, 'error', `Lỗi activity quest ${questName}: ${msg}`);
			await sleep(5000);
		}
	}

	// aiko: Send terminal heartbeat after completion
	try {
		await enqueueApiCall(tokenId, `/quests/${questId}/heartbeat`, {
			stream_key: streamKey,
			terminal: true,
		});
	} catch {
		/* ignore */
	}

	updateQuestProgress(tokenId, questId, 100, 'completed');
	addLog(tokenId, 'success', `Quest Activity ${questName} hoàn thành!`);
	// Delay nhẹ 1s để UI load hoàn thành trước khi chuyển quest tiếp theo
	await sleep(1000);
}
