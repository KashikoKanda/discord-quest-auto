import { addLog, getGlobalState, sleep, updateQuestProgress } from '../core/state';
import { enqueueApiCall } from '../core/queue';
import { buildSuperProperties, discordFetch } from '../api/client';
import { getUserAgent, isGatewayReady } from '../api/gateway';

async function getProxyTicket(tokenId: string, applicationId: string): Promise<string | null> {
	try {
		const res = await enqueueApiCall(tokenId, `/applications/${applicationId}/proxy-tickets`, {});
		if (res.ok && res.data?.ticket) {
			return res.data.ticket as string;
		}
		addLog(tokenId, 'warn', `Không lấy được proxy ticket (status ${res.status})`);
		return null;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		addLog(tokenId, 'warn', `Lỗi lấy proxy ticket: ${msg}`);
		return null;
	}
}

/**
 * Build the activity referrer URL — aiko-style:
 *   https://{appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket={ticket}
 */
async function buildActivityReferrer(tokenId: string, applicationId: string): Promise<string | null> {
	const ticket = await getProxyTicket(tokenId, applicationId);
	if (!ticket) return null;
	const referrer = new URL(`https://${applicationId}.discordsays.com/`);
	referrer.searchParams.set('instance_id', 'example-cl-instance');
	referrer.searchParams.set('platform', 'desktop');
	referrer.searchParams.set('discord_proxy_ticket', ticket);
	return referrer.toString();
}

/**
 * Build the activity headers for Discord Says API calls.
 *
 * Mirrors aiko's flow exactly:
 *   1. makeDesktopHeaders(false, false)  → UA + sec-ch-ua + pragma + accept-language
 *      (NO x-super-properties, NO origin, NO referer — both flags false)
 *   2. getActivityHeaders(questId, authToken, activityReferrer) → merged on top:
 *      - Content-Type: application/json
 *      - X-Auth-Token: authToken
 *      - X-Discord-Quest-ID: questId
 *      - Referer: activityReferrer
 *
 * Important: do NOT send Authorization (Discord token), x-super-properties,
 * x-debug-options, x-discord-locale, x-discord-timezone, origin — aiko's
 * makeDesktopHeaders(false, false) intentionally omits all of these for the
 * discordsays.com calls. Sending them causes "Env data not found" 500 errors.
 */
async function buildActivityHeaders(
	tokenId: string,
	questId: string,
	authToken: string,
	activityReferrer: string,
): Promise<Record<string, string>> {
	// Get the User-Agent (matches the discord client UA used elsewhere)
	let userAgent: string;
	const state = getGlobalState().get(tokenId);
	if (!state) {
		userAgent =
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9236 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';
	} else if (isGatewayReady(tokenId)) {
		userAgent = getUserAgent(tokenId);
	} else {
		const built = await buildSuperProperties(tokenId);
		userAgent = built.fp.userAgent;
	}

	// aiko: makeDesktopHeaders(false, false) — NO origin, NO referer, NO x-super-properties
	const headers: Record<string, string> = {
		'accept-language': 'vi',
		'User-Agent': userAgent,
		pragma: 'no-cache',
		priority: 'u=1, i',
		'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'sec-fetch-dest': 'empty',
		'sec-fetch-mode': 'cors',
		'sec-fetch-site': 'same-origin',
	};

	// aiko: getActivityHeaders merged on top via headers.append()
	headers['Content-Type'] = 'application/json';
	headers['X-Auth-Token'] = authToken;
	headers['X-Discord-Quest-ID'] = questId;
	headers['Referer'] = activityReferrer;

	return headers;
}

export async function doAchievementInActivityQuest(tokenId: string, quest: Record<string, unknown>): Promise<void> {
	const questId = quest.id as string;
	const config = quest.config as Record<string, unknown> | undefined;
	const questName = (config?.messages as Record<string, string>)?.quest_name || questId;
	const application = config?.application as Record<string, unknown> | undefined;
	const applicationId = application?.id as string;
	const applicationName = (application?.name as string) || 'Unknown';

	// Get the target from task config
	const tasks = config?.task_config_v2 as Record<string, unknown> | undefined;
	const taskMap = tasks?.tasks as Record<string, unknown> | undefined;
	const achievementTask = taskMap?.ACHIEVEMENT_IN_ACTIVITY as Record<string, unknown> | undefined;
	const questTarget = (achievementTask?.target as number) || 1;

	addLog(
		tokenId,
		'info',
		`Bắt đầu quest Achievement: ${questName} (app: ${applicationName}, target: ${questTarget})`,
	);
	updateQuestProgress(tokenId, questId, 0, 'running');

	const state = getGlobalState().get(tokenId);
	if (!state) return;

	try {
		// Step 1: Authorize with the application (OAuth2) - aiko-style
		addLog(tokenId, 'info', `Đang xác thực với ${applicationName}...`);

		const query = new URLSearchParams({
			response_type: 'code',
			client_id: applicationId,
			scope: 'identify applications.commands applications.entitlements',
			state: '',
		});

		const authRes = await enqueueApiCall(tokenId, `/oauth2/authorize?${query.toString()}`, {
			permissions: '0',
			authorize: true,
			integration_type: 1,
			location_context: {
				guild_id: '10000',
				channel_id: '10000',
				channel_type: 10000,
			},
		});

		if (!authRes.ok) {
			addLog(tokenId, 'error', `Xác thực OAuth2 thất bại cho ${applicationName}: ${authRes.status}`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		// Step 2: Extract auth code from response
		const location = authRes.data?.location;
		let authCode: string | null = null;
		if (location) {
			try {
				authCode = new URL(location).searchParams.get('code');
			} catch {
				const match = location.match(/[?&]code=([^&]+)/);
				authCode = match ? match[1] : null;
			}
		}

		if (!authCode) {
			addLog(tokenId, 'error', `Không nhận được auth code từ ${applicationName}`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		addLog(tokenId, 'success', `Đã xác thực với ${applicationName}`);
		updateQuestProgress(tokenId, questId, 30, 'running');

		// Step 3: Build activity referrer with proxy ticket (aiko-style)
		addLog(tokenId, 'info', `Đang lấy proxy ticket...`);
		const activityReferrer = await buildActivityReferrer(tokenId, applicationId);
		if (!activityReferrer) {
			addLog(tokenId, 'error', `Không lấy được proxy ticket cho ${applicationName}`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		// Step 4: Authorize with Discord Says (aiko-style)
		// POST https://{appId}.discordsays.com/.proxy/acf/authorize
		// Headers: X-Discord-Quest-ID, X-Auth-Token (empty), Referer=activityReferrer, Origin, UA, x-super-properties
		addLog(tokenId, 'info', `Đang lấy token Discord Says...`);

		const authorizeHeaders = await buildActivityHeaders(tokenId, questId, '', activityReferrer);
		const dsTokenRes = await fetch(`https://${applicationId}.discordsays.com/.proxy/acf/authorize`, {
			method: 'POST',
			headers: authorizeHeaders,
			body: JSON.stringify({ code: authCode }),
		});

		if (!dsTokenRes.ok) {
			const errText = await dsTokenRes.text().catch(() => '');
			addLog(tokenId, 'error', `Lấy Discord Says token thất bại: ${dsTokenRes.status} ${errText.slice(0, 150)}`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		const dsData = (await dsTokenRes.json().catch(() => ({}))) as { token?: string };
		const dsToken = dsData.token;

		if (!dsToken) {
			addLog(tokenId, 'error', `Không nhận được token từ Discord Says`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		addLog(tokenId, 'success', `Đã lấy Discord Says token`);
		updateQuestProgress(tokenId, questId, 50, 'running');

		// Step 5: Progress the achievement via Discord Says API (aiko-style)
		// POST https://{appId}.discordsays.com/.proxy/acf/quest/progress
		// Headers: X-Discord-Quest-ID, X-Auth-Token=dsToken, Referer=activityReferrer
		addLog(tokenId, 'info', `Đang hoàn thành achievement (target: ${questTarget})...`);

		const progressHeaders = await buildActivityHeaders(tokenId, questId, dsToken, activityReferrer);
		const progressRes = await fetch(`https://${applicationId}.discordsays.com/.proxy/acf/quest/progress`, {
			method: 'POST',
			headers: progressHeaders,
			body: JSON.stringify({
				quest_id: questId,
				progress: questTarget,
			}),
		});

		if (!progressRes.ok) {
			const errText = await progressRes.text().catch(() => '');
			addLog(tokenId, 'error', `Hoàn thành achievement thất bại: ${progressRes.status} ${errText.slice(0, 150)}`);
			updateQuestProgress(tokenId, questId, 0, 'failed');
			return;
		}

		addLog(tokenId, 'success', `Đã hoàn thành achievement!`);
		updateQuestProgress(tokenId, questId, 80, 'running');

		// Step 6: Deauthorize the application (cleanup - aiko-style)
		try {
			const tokensRes = await enqueueApiCall(tokenId, '/oauth2/tokens', {});
			if (tokensRes.ok && Array.isArray(tokensRes.data)) {
				const tokenInfo = tokensRes.data.find(
					(t: Record<string, unknown>) => (t.application as Record<string, unknown>)?.id === applicationId,
				);
				if (tokenInfo?.id) {
					// Use DELETE method (aiko uses rest.delete)
					await discordFetch(
						state.token,
						`/oauth2/tokens/${tokenInfo.id}`,
						{
							method: 'DELETE',
						},
						tokenId,
					);
					addLog(tokenId, 'info', `Đã huỷ uỷ quyền ${applicationName}`);
				}
			}
		} catch {
			// Deauth failure is not critical
		}

		updateQuestProgress(tokenId, questId, 100, 'completed');
		addLog(tokenId, 'success', `Quest Achievement ${questName} hoàn thành!`);
		// Delay nhẹ 1s để UI load hoàn thành trước khi chuyển quest tiếp theo
		await sleep(1000);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		addLog(tokenId, 'error', `Lỗi achievement quest ${questName}: ${msg}`);
		updateQuestProgress(tokenId, questId, 0, 'failed');
	}
}
