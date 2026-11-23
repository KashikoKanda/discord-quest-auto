import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { AUTO_INTERVAL_MS } from './core/constants';
import { fetchDiscordQuests, enrollQuest, clearFingerprint, initBuildVersion } from './api/client';
import { connectGateway, disconnectGateway } from './api/gateway';
import { addLog, clearAllIntervals, getGlobalState, rnd, sleep } from './core/state';
import type { QuestProgress, TokenState } from './core/state';
import { isQuestCompleted, isQuestExpired } from './quests/quest';
import { processQuest } from './quests';

const AUTO_LOOP_INTERVAL_MS = AUTO_INTERVAL_MS;

/**
 * Dấu hiệu "đang có lượt chạy quest". Dùng để không ai dựng lại bot giữa chừng:
 * process chết là lượt chạy mất, tiến trình trên Discord đứng im.
 */
const RUN_MARKER = process.env.QUEST_RUN_MARKER ?? '.quest-running';

function markRunning(tokenId: string): void {
	try {
		writeFileSync(RUN_MARKER, JSON.stringify({ tokenId, pid: process.pid, since: new Date().toISOString() }), {
			mode: 0o600,
		});
	} catch {
		/* marker chỉ là tiện ích */
	}
}

function unmarkRunning(): void {
	try {
		if (existsSync(RUN_MARKER)) rmSync(RUN_MARKER);
	} catch {
		/* bỏ qua */
	}
}
const GAP_MS = 10_000;
const GAP_JITTER_MS = 5_000;

async function processAllQuests(tokenId: string, multiQuest: boolean = false, gapMs: number = GAP_MS): Promise<void> {
	const state = getGlobalState().get(tokenId);
	if (!state) return;

	state.status = 'running';
	markRunning(tokenId);
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
				if (i < doableQuests.length - 1) {
					const delay = Math.floor(Math.random() * GAP_JITTER_MS) + gapMs;
					addLog(tokenId, 'info', `Nghỉ ${(delay / 1000).toFixed(1)}s trước khi làm quest tiếp theo...`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		addLog(tokenId, 'info', 'Đã xử lý xong quest.');

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
	} finally {
		unmarkRunning();
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
				await processAllQuests(tokenId).catch((err: unknown) => {
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

	startQuests(
		tokenId: string,
		questId?: string,
		multiQuest: boolean = false,
		gapMs: number = GAP_MS,
	): { started: boolean; message: string } {
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
				// Chỉ báo ở đây cho đường chạy 1 quest; processAllQuests tự báo.
				if (questId) addLog(tokenId, 'success', 'Đã kết nối Discord Gateway!');
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
			processAllQuests(tokenId, multiQuest, gapMs);
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
	): Promise<{ success: boolean; captcha?: boolean; message: string }> {
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
			// Discord chặn mọi lần nhận thưởng bằng hCaptcha khi thấy tài khoản không
			// phải client chính thức. Không có đường vòng hợp lệ, nên báo rõ để người
			// dùng mở app nhận tay thay vì thử lại liên tục.
			if (text.includes('captcha')) {
				addLog(tokenId, 'warn', `Quest ${questId} cần captcha khi nhận thưởng, phải nhận trong app Discord.`);
				return { success: false, captcha: true, message: 'Discord yêu cầu captcha, cần nhận trong app' };
			}
			addLog(tokenId, 'error', `Nhận thưởng quest ${questId} thất bại: ${res.status}`);
			return { success: false, message: `Lỗi: ${res.status} ${text.slice(0, 100)}` };
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { success: false, message: msg };
		}
	},

	/** Quest có trong danh mục công khai nhưng tài khoản này không thấy. */
	async hiddenQuests(tokenId: string, country: string = 'VN') {
		const state = getGlobalState().get(tokenId);
		if (!state) return [];

		const { fetchDiscordQuests } = await import('./api/client');
		const { fetchHiddenQuests } = await import('./api/catalog');
		const { quests } = await fetchDiscordQuests(state.token, tokenId);
		const owned = new Set(quests.map((quest) => String((quest as Record<string, unknown>).id)));
		return fetchHiddenQuests(owned, country);
	},

	/** Nhận một quest ẩn bằng id để đưa nó vào danh sách làm được. */
	async enrollHidden(tokenId: string, questId: string): Promise<{ success: boolean; message: string }> {
		const state = getGlobalState().get(tokenId);
		if (!state) return { success: false, message: 'Token chưa đăng ký' };

		const { enrollQuest } = await import('./api/client');
		const { fetchCatalog, fetchRegions } = await import('./api/catalog');
		const { pickProxy } = await import('./core/proxies');
		const catalog = await fetchCatalog().catch(() => []);
		const quest = catalog.find((item) => item.id === questId);

		// Quest giới hạn vùng: chọn proxy mang thẻ quốc gia tương ứng nếu có.
		const regions = await fetchRegions().catch(() => new Map());
		const region = regions.get(questId);
		const country = region && region.include.length > 0 ? region.include[0] : null;
		const proxy = await pickProxy(country).catch(() => null);

		const res = await enrollQuest(state.token, questId, false, tokenId, quest?.raw, proxy?.url);
		const body = await res.text().catch(() => '');
		const viaProxy = Boolean(proxy);

		// KHÔNG thử lại trực tiếp khi proxy hỏng: cùng một token xuất hiện ở hai IP
		// trong vài giây chính là mẫu Discord coi là phiên bị đánh cắp. Thà báo lỗi.
		if (!res.ok && proxy && (res.status === 403 || res.status === 429 || body.includes('260008'))) {
			addLog(
				tokenId,
				'warn',
				`Proxy ${proxy.label} không nhận được quest ${questId}; giữ nguyên IP, không thử trực tiếp.`,
			);
		}

		if (res.ok || res.status === 204) {
			const via = viaProxy && proxy ? ` qua ${proxy.label}` : '';
			addLog(tokenId, 'success', `Đã nhận quest ẩn ${quest?.name ?? questId}${via}`);
			return { success: true, message: `Đã nhận ${quest?.name ?? questId}${via}` };
		}

		// Mã lỗi Discord khi nhận quest, dịch sang câu dễ hiểu.
		let code = 0;
		try {
			code = Number((JSON.parse(body) as Record<string, unknown>).code ?? 0);
		} catch {
			/* body không phải JSON */
		}
		const map: Record<number, string> = {
			260008: 'Quest không tồn tại hoặc tài khoản không đủ điều kiện',
			40001: 'Token không hợp lệ hoặc đã hết hạn',
			50001: 'Tài khoản không có quyền nhận quest này',
			50000: 'Tài khoản bị chặn nhận quest',
		};
		const message =
			map[code] ??
			(res.status === 403
				? 'Quest không khả dụng ở vùng của tài khoản'
				: res.status === 429
					? 'Discord giới hạn tần suất, thử lại sau'
					: `${res.status} ${body.slice(0, 120)}`);
		addLog(tokenId, 'warn', `Nhận quest ẩn ${questId} thất bại: ${message}`);
		return { success: false, message };
	},

	/** Nhận thưởng cho mọi quest đã xong mà chưa nhận, lần lượt từng cái. */
	async claimAll(tokenId: string): Promise<{
		total: number;
		claimed: number;
		captcha: number;
		failed: number;
		names: string[];
	}> {
		const state = getGlobalState().get(tokenId);
		if (!state) return { total: 0, claimed: 0, captcha: 0, failed: 0, names: [] };

		const { fetchDiscordQuests } = await import('./api/client');
		const { Quest } = await import('./quests/quest');
		const { quests } = await fetchDiscordQuests(state.token, tokenId);
		const pending = quests
			.map((item) => Quest.create(item as Parameters<typeof Quest.create>[0]))
			.filter((quest) => quest.isCompleted() && !quest.isClaimed());

		const result = { total: pending.length, claimed: 0, captcha: 0, failed: 0, names: [] as string[] };
		for (const quest of pending) {
			result.names.push(quest.name);
			const one = await this.claimReward(tokenId, quest.id, quest.raw);
			if (one.success) result.claimed += 1;
			else if (one.captcha) result.captcha += 1;
			else result.failed += 1;
			await sleep(rnd(1500, 3000));
		}
		return result;
	},
};
