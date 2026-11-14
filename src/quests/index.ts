import { addLog, getGlobalState, sleep, updateQuestProgress } from '../core/state';
import { enrollQuest } from '../api/client';
import { getQuestType, isQuestCompleted, isQuestExpired } from './quest';
import { doWatchVideoQuest } from './video';
import { doPlayOnDesktopQuest } from './play';
import { doPlayActivityQuest } from './activity';
import { doAchievementInActivityQuest } from './achievement';

export async function processQuest(tokenId: string, quest: Record<string, unknown>): Promise<void> {
	const questId = quest.id as string;
	const questType = getQuestType(quest);
	const config = quest.config as Record<string, unknown> | undefined;
	const questName =
		(config?.messages as Record<string, string>)?.quest_name ||
		(config?.messages as Record<string, string>)?.game_title ||
		questId;

	if (isQuestCompleted(quest)) {
		addLog(tokenId, 'info', `Quest ${questName} đã hoàn thành, bỏ qua`);
		return;
	}

	if (isQuestExpired(quest)) {
		addLog(tokenId, 'warn', `Quest ${questName} đã hết hạn, bỏ qua`);
		return;
	}

	// Enroll if not enrolled - aiko: acceptQuest with traffic_metadata
	const userStatus = quest.user_status as Record<string, unknown> | undefined;
	if (!userStatus?.enrolled_at) {
		try {
			// aiko: detect isAndroid from task config
			const taskConfig = config?.task_config_v2 as Record<string, unknown> | undefined;
			const taskMap = taskConfig?.tasks as Record<string, unknown> | undefined;
			const isAndroid = Boolean(taskMap?.WATCH_VIDEO_ON_MOBILE) && !Boolean(taskMap?.WATCH_VIDEO);

			addLog(tokenId, 'info', `Đang đăng ký quest ${questName} (${isAndroid ? 'Mobile' : 'Desktop'})...`);
			const state = getGlobalState().get(tokenId);
			if (!state) return;
			const res = await enrollQuest(state.token, questId, isAndroid, tokenId, quest);
			if (res.ok || res.status === 204) {
				addLog(tokenId, 'success', `Đã đăng ký quest ${questName}`);
				// Update quest user_status from enrollment response
				try {
					const enrollData = (await res.json().catch(() => null)) as Record<string, any> | null;
					if (enrollData?.user_status) {
						quest.user_status = enrollData.user_status;
					}
				} catch {
					/* ignore */
				}
				await sleep(2000);
			} else {
				const text = await res.text().catch(() => '');
				addLog(tokenId, 'error', `Đăng ký quest ${questName} thất bại: ${res.status} ${text.slice(0, 100)}`);
				return;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			addLog(tokenId, 'error', `Lỗi đăng ký quest ${questName}: ${msg}`);
			return;
		}
	}

	const state = getGlobalState().get(tokenId);
	if (!state) return;

	const abortCtrl = new AbortController();
	state.abortControllers.set(questId, abortCtrl);

	try {
		switch (questType) {
			case 'WATCH_VIDEO':
			case 'WATCH_VIDEO_ON_MOBILE':
				await doWatchVideoQuest(tokenId, quest);
				break;
			case 'PLAY_ON_DESKTOP':
			case 'PLAY_ON_XBOX':
			case 'PLAY_ON_PLAYSTATION':
				await doPlayOnDesktopQuest(tokenId, quest);
				break;
			case 'PLAY_ACTIVITY':
				await doPlayActivityQuest(tokenId, quest);
				break;
			case 'STREAM_ON_DESKTOP':
				// aiko: STREAM_ON_DESKTOP no longer works in Node
				addLog(tokenId, 'warn', `Quest Stream ${questName} không hoạt động trên Node.js, bỏ qua`);
				break;
			case 'ACHIEVEMENT_IN_ACTIVITY':
				await doAchievementInActivityQuest(tokenId, quest);
				break;
			default:
				addLog(tokenId, 'warn', `Loại quest không xác định: ${questType} - bỏ qua`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		addLog(tokenId, 'error', `Lỗi xử lý quest ${questName}: ${msg}`);
		updateQuestProgress(tokenId, questId, 0, 'failed');
	}
}

// aiko: ALL quests run in parallel (Promise.allSettled)
