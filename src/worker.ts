import { AUTO_INTERVAL_MS } from './core/constants';
import { fetchDiscordQuests, enrollQuest, clearFingerprint, initBuildVersion } from './api/client';
import { connectGateway, disconnectGateway } from './api/gateway';
import { addLog, clearAllIntervals, getGlobalState } from './core/state';
import type { QuestProgress, TokenState } from './core/state';
import { isQuestCompleted, isQuestExpired } from './quests/quest';
import { processQuest } from './quests';

const AUTO_LOOP_INTERVAL_MS = AUTO_INTERVAL_MS;

async function processAllQuests(
	tokenId: string,
	skipAutoClaim: boolean = false,
	multiQuest: boolean = false,
): Promise<void> {
	const state = getGlobalState().get(tokenId);
	if (!state) return;

	state.status = 'running';
	addLog(tokenId, 'info', 'Bắt đầu xử lý tất cả quest...');

	try {
		// Connect to Discord Gateway first (required for heartbeat/video-progress APIs)
		addLog(tokenId, 'info', 'Đang kết nối Discord Gateway...');
		const gatewayOk = await connectGateway(tokenId, state.token);
		if (!gatewayOk) {
			addLog(tokenId, 'warn', 'Không kết nối được Gateway, tiếp tục không có gateway session...');
		} else {
			addLog(tokenId, 'success', 'Đã kết nối Discord Gateway!');
		}

		addLog(tokenId, 'info', 'Đang tải danh sách quest...');
		const { quests } = await fetchDiscordQuests(state.token, tokenId);

		// aiko: filterQuestsValidToDo - only not completed and not expired
		const doableQuests = quests.filter((q: Record<string, unknown>) => {
			if (isQuestCompleted(q)) return false;
			if (isQuestExpired(q)) return false;
			return true;
		});

		addLog(tokenId, 'info', `Tìm thấy ${quests.length} quest, ${doableQuests.length} quest cần làm`);

		if (multiQuest) {
			// ─── MULTI MODE: Parallel (như ban đầu) ───
			// Tất cả quest chạy song song cùng lúc
			addLog(tokenId, 'info', `Đang làm ${doableQuests.length} quest (song song - multi mode)...`);
			await Promise.allSettled(
				doableQuests.map((quest: Record<string, unknown>) => processQuest(tokenId, quest)),
			);
		} else {
			// ─── SINGLE MODE: Sequential (an toàn hơn) ───
			// Làm từng quest cho đến khi hết, delay 8-15s giữa mỗi quest
			addLog(tokenId, 'info', `Đang làm ${doableQuests.length} quest (lần lượt - single mode)...`);
			for (let i = 0; i < doableQuests.length; i++) {
				const quest = doableQuests[i];
				const questName = ((quest as Record<string, unknown>)?.name as string) || `quest ${i + 1}`;
				addLog(tokenId, 'info', `[${i + 1}/${doableQuests.length}] Đang làm quest: ${questName}`);
				await processQuest(tokenId, quest);
				// Random delay 8-15s giữa mỗi quest (trừ quest cuối)
				if (i < doableQuests.length - 1) {
					const delay = Math.floor(Math.random() * 7000) + 8000; // 8000-15000ms
					addLog(tokenId, 'info', `Nghỉ ${(delay / 1000).toFixed(1)}s trước khi làm quest tiếp theo...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		// Manual start path (skipAutoClaim=false) runs the optional post-completion
		// reward claiming. The auto-quest loop passes skipAutoClaim=true.
		if (!skipAutoClaim) {
			const autoClaimEnabled = state.isVerified;
			if (autoClaimEnabled) {
				addLog(tokenId, 'info', 'Đang tự động nhận thưởng các quest đã hoàn thành...');
				const { claimQuestReward } = await import('./api/client');
				// Re-fetch quests to get latest status
				try {
					const { quests: latestQuests } = await fetchDiscordQuests(state.token, tokenId);
					for (const q of latestQuests) {
						const userStatus = q.user_status as Record<string, unknown> | undefined;
						const isCompleted = userStatus?.completed_at != null;
						const isClaimed = userStatus?.claimed_at != null;
						if (isCompleted && !isClaimed) {
							try {
								const res = await claimQuestReward(
									state.token,
									q.id as string,
									q as Record<string, unknown>,
									tokenId,
								);
								if (res.ok) {
									addLog(
										tokenId,
										'success',
										`Đã tự động nhận thưởng quest ${((q.config as Record<string, unknown>)?.messages && ((q.config as Record<string, unknown>).messages as Record<string, string>)?.quest_name) || (q.id as string).slice(0, 8)}`,
									);
								} else {
									addLog(
										tokenId,
										'warn',
										`Tự nhận thưởng thất bại cho quest ${(q.id as string).slice(0, 8)}: ${res.status}`,
									);
								}
							} catch {
								// Ignore claim errors
							}
						}
					}
				} catch {
					addLog(tokenId, 'warn', 'Không thể tải lại danh sách quest để tự nhận thưởng');
				}
			}
		} else {
			addLog(tokenId, 'info', 'Đã xử lý xong quest.');
		}

		// Disconnect gateway after all quests done
		disconnectGateway(tokenId);

		if (state.status === 'running') {
			state.status = 'idle';
			addLog(tokenId, 'success', 'Đã xử lý xong tất cả quest!');
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		state.status = 'error';
		addLog(tokenId, 'error', `Lỗi: ${msg}`);
	}
}

// Separate from manual start/stop. When enabled:
//   1. Ticks every AUTO_LOOP_INTERVAL_MS
//   2. Each tick fetches quests from Discord and processes any that are
//      not-completed AND not-expired (skips already-running ones to avoid
//      duplicate work, but DOES pick up quests that finished since last tick)
//   3. Self-stops when no quests remain OR when worker is manually stopped

function stopAutoQuestLoop(tokenId: string): void {
	const state = getGlobalState().get(tokenId);
	if (!state) return;
	if (state.autoQuestLoopTimer) {
		clearTimeout(state.autoQuestLoopTimer);
		state.autoQuestLoopTimer = undefined;
	}
	state.autoQuestLoopRunning = false;
}

async function runAutoQuestLoopTick(tokenId: string): Promise<void> {
	const state = getGlobalState().get(tokenId);
	if (!state) return;
	if (!state.autoQuestEnabled) return;
	if (state.autoQuestLoopRunning) return; // skip overlap

	state.autoQuestLoopRunning = true;
	try {
		// Don't kick off a new batch if there's already one running
		if (state.status !== 'running') {
			addLog(tokenId, 'info', '[Auto-Quest] Đang kiểm tra quest chưa hoàn thành...');
			const { quests } = await fetchDiscordQuests(state.token, tokenId);

			const doableQuests = quests.filter((q: Record<string, unknown>) => {
				if (isQuestCompleted(q)) return false;
				if (isQuestExpired(q)) return false;
				return true;
			});

			if (doableQuests.length === 0) {
				addLog(tokenId, 'info', '[Auto-Quest] Không có quest nào cần làm, chờ tick tiếp theo.');
			} else {
				addLog(tokenId, 'info', `[Auto-Quest] Phát hiện ${doableQuests.length} quest chưa làm, đang xử lý...`);
				// processAllQuests(tokenId, true) → skipAutoClaim=true: only completes quests.
				await processAllQuests(tokenId, true).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					addLog(tokenId, 'error', `[Auto-Quest] Lỗi xử lý: ${msg}`);
				});
				// ─── Cooldown sau khi làm quest xong ───
				// Nghỉ 2 phút sau khi làm quest xong trước khi tick tiếp theo
				// Tránh Discord flag spam do API calls dồn dập
				addLog(tokenId, 'info', '[Auto-Quest] Nghỉ 2 phút trước khi kiểm tra lại...');
				await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		addLog(tokenId, 'error', `[Auto-Quest] Lỗi tick: ${msg}`);
	} finally {
		state.autoQuestLoopRunning = false;
		// Schedule next tick — only if still enabled
		if (state.autoQuestEnabled) {
			state.autoQuestLoopTimer = setTimeout(() => {
				runAutoQuestLoopTick(tokenId).catch(() => {
					/* swallow */
				});
			}, AUTO_LOOP_INTERVAL_MS);
		}
	}
}

function startAutoQuestLoop(tokenId: string): void {
	const state = getGlobalState().get(tokenId);
	if (!state) return;
	if (state.autoQuestEnabled && state.autoQuestLoopTimer) return; // already running
	state.autoQuestEnabled = true;
	addLog(tokenId, 'success', '[Auto-Quest] Đã bật tự động làm quest.');
	// Kick off first tick immediately
	runAutoQuestLoopTick(tokenId).catch(() => {
		/* swallow */
	});
}

export const QuestWorker = {
	registerToken(tokenId: string, token: string, isVerified: boolean = false, _autoClaim: boolean = true): void {
		const state = getGlobalState();
		if (state.has(tokenId)) {
			const existing = state.get(tokenId)!;
			existing.token = token;
			existing.isVerified = isVerified;
			return;
		}
		state.set(tokenId, {
			token,
			status: 'idle',
			isVerified,
			questProgress: new Map(),
			logs: [],
			intervals: [],
			abortControllers: new Map(),
			apiQueue: [],
			queueProcessing: false,
			autoQuestEnabled: false,
		});
	},

	async removeToken(tokenId: string): Promise<void> {
		stopAutoQuestLoop(tokenId);
		clearAllIntervals(tokenId);
		await clearFingerprint(tokenId);
		getGlobalState().delete(tokenId);
	},

	startQuests(tokenId: string, questId?: string, multiQuest: boolean = false): { started: boolean; message: string } {
		const state = getGlobalState().get(tokenId);
		if (!state) {
			return { started: false, message: 'Token chưa đăng ký' };
		}
		if (state.status === 'running') {
			return { started: false, message: 'Quest đang chạy' };
		}

		// Ensure build version is loaded
		initBuildVersion().catch(() => {});

		// Connect to Discord Gateway first (required for heartbeat/video-progress APIs)
		const gatewayConnect = connectGateway(tokenId, state.token).then((ok) => {
			if (ok) {
				addLog(tokenId, 'success', 'Đã kết nối Discord Gateway!');
			} else {
				addLog(tokenId, 'warn', 'Không kết nối được Gateway, tiếp tục không có gateway session...');
			}
		});

		if (questId) {
			addLog(tokenId, 'info', `Bắt đầu xử lý quest ${questId}...`);
			(async () => {
				try {
					await gatewayConnect;
					const { quests } = await fetchDiscordQuests(state.token, tokenId);
					const quest = quests.find((q: Record<string, unknown>) => q.id === questId);
					if (!quest) {
						addLog(tokenId, 'error', `Không tìm thấy quest ${questId}`);
						return;
					}
					state.status = 'running';
					await processQuest(tokenId, quest);

					// Auto-claim if verified and completed
					if (state.isVerified) {
						const userStatus = quest.user_status as Record<string, unknown> | undefined;
						if (userStatus?.completed_at && !userStatus?.claimed_at) {
							try {
								const { claimQuestReward } = await import('./api/client');
								const claimRes = await claimQuestReward(
									state.token,
									questId,
									quest as Record<string, unknown>,
									tokenId,
								);
								if (claimRes.ok) {
									addLog(tokenId, 'success', `Đã tự động nhận thưởng quest ${questId}`);
								}
							} catch {
								/* ignore */
							}
						}
					}

					disconnectGateway(tokenId);
					if (state.status === 'running') state.status = 'idle';
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					state.status = 'error';
					addLog(tokenId, 'error', `Lỗi: ${msg}`);
				}
			})();
		} else {
			// multiQuest = true → parallel (tất cả cùng lúc — như ban đầu)
			// multiQuest = false → sequential (từng quest cho đến khi hết — an toàn hơn)
			processAllQuests(tokenId, false, multiQuest);
		}

		return {
			started: true,
			message: multiQuest ? 'Đã bắt đầu xử lý tất cả quest (song song)' : 'Đã bắt đầu xử lý từng quest (tuần tự)',
		};
	},

	stopQuests(tokenId: string, questId?: string): { stopped: boolean; message: string } {
		const state = getGlobalState().get(tokenId);
		if (!state) {
			return { stopped: false, message: 'Token chưa đăng ký' };
		}

		if (questId) {
			const ctrl = state.abortControllers.get(questId);
			if (ctrl) ctrl.abort();
			const progress = state.questProgress.get(questId);
			if (progress) progress.status = 'paused';
			addLog(tokenId, 'info', `Đã dừng quest ${questId}`);
			return { stopped: true, message: `Đã dừng quest ${questId}` };
		}

		clearAllIntervals(tokenId);
		state.status = 'idle';
		for (const [, progress] of state.questProgress) {
			if (progress.status === 'running') progress.status = 'paused';
		}
		addLog(tokenId, 'info', 'Đã dừng tất cả quest');
		return { stopped: true, message: 'Đã dừng tất cả quest' };
	},

	async enroll(
		tokenId: string,
		questId: string,
		isMobile: boolean = false,
	): Promise<{ enrolled: boolean; message: string }> {
		const state = getGlobalState().get(tokenId);
		if (!state) return { enrolled: false, message: 'Token chưa đăng ký' };

		try {
			const res = await enrollQuest(state.token, questId, isMobile, tokenId);
			if (res.ok || res.status === 204) {
				addLog(tokenId, 'success', `Đã đăng ký quest ${questId}`);
				return { enrolled: true, message: 'Đã đăng ký' };
			}
			const text = await res.text().catch(() => '');
			return { enrolled: false, message: `Lỗi: ${res.status} ${text.slice(0, 100)}` };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { enrolled: false, message: msg };
		}
	},

	getState(tokenId: string): TokenState | undefined {
		return getGlobalState().get(tokenId);
	},

	getQuestProgress(tokenId: string, questId: string): QuestProgress | undefined {
		return getGlobalState().get(tokenId)?.questProgress.get(questId);
	},

	getAllQuestProgress(tokenId: string): Map<string, QuestProgress> {
		return getGlobalState().get(tokenId)?.questProgress || new Map();
	},

	getLogs(tokenId: string): Array<{ level: string; message: string; timestamp: number }> {
		return getGlobalState().get(tokenId)?.logs || [];
	},

	getStatus(tokenId: string): 'idle' | 'running' | 'error' | 'unknown' {
		return getGlobalState().get(tokenId)?.status || 'unknown';
	},

	setAutoClaim(tokenId: string, enabled: boolean): { success: boolean; message: string } {
		const state = getGlobalState().get(tokenId);
		if (!state) return { success: false, message: 'Token chưa đăng ký' };
		if (enabled && !state.isVerified) {
			return { success: false, message: 'Tài khoản chưa xác minh không thể bật auto-claim' };
		}
		return { success: true, message: enabled ? 'Auto-claim đã bật' : 'Auto-claim đã tắt' };
	},

	getAutoClaim(tokenId: string): boolean {
		const state = getGlobalState().get(tokenId);
		return state?.isVerified ?? false;
	},

	getVerified(tokenId: string): boolean {
		const state = getGlobalState().get(tokenId);
		return state?.isVerified ?? false;
	},

	/**
	 * Enable/disable the background auto-quest loop.
	 * - enable=true  → register token if needed, start the loop tick
	 * - enable=false → stop the loop timer (does NOT abort an in-flight batch)
	 * Caller is responsible for guild-membership verification (this method does
	 * NOT re-check Discord) — UI must gate the call behind isGuildMember.
	 */
	setAutoQuest(
		tokenId: string,
		token: string,
		enabled: boolean,
		isVerified: boolean,
	): { success: boolean; message: string } {
		// Auto-register the token if missing (so toggling on first time works
		// even without a prior /quests/start call)
		if (!getGlobalState().has(tokenId)) {
			this.registerToken(tokenId, token, isVerified, isVerified);
		}
		const state = getGlobalState().get(tokenId);
		if (!state) return { success: false, message: 'Token chưa đăng ký' };

		if (enabled) {
			if (!isVerified) {
				return { success: false, message: 'Tài khoản chưa xác minh không thể bật tự động làm quest' };
			}
			startAutoQuestLoop(tokenId);
			return { success: true, message: 'Đã bật tự động làm quest' };
		}
		state.autoQuestEnabled = false;
		stopAutoQuestLoop(tokenId);
		addLog(tokenId, 'info', '[Auto-Quest] Đã tắt tự động làm quest.');
		return { success: true, message: 'Đã tắt tự động làm quest' };
	},

	getAutoQuest(tokenId: string): boolean {
		const state = getGlobalState().get(tokenId);
		return state?.autoQuestEnabled ?? false;
	},

	async claimReward(
		tokenId: string,
		questId: string,
		questData?: Record<string, unknown>,
	): Promise<{ success: boolean; message: string }> {
		const state = getGlobalState().get(tokenId);
		if (!state) return { success: false, message: 'Token chưa đăng ký' };

		try {
			const { claimQuestReward } = await import('./api/client');
			const res = await claimQuestReward(state.token, questId, questData, tokenId);
			if (res.ok) {
				addLog(tokenId, 'success', `Đã nhận thưởng quest ${questId}`);
				return { success: true, message: 'Đã nhận thưởng' };
			}
			const text = await res.text().catch(() => '');
			addLog(tokenId, 'error', `Nhận thưởng quest ${questId} thất bại: ${res.status}`);
			return { success: false, message: `Lỗi: ${res.status} ${text.slice(0, 100)}` };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, message: msg };
		}
	},
};
