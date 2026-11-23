import { randomUUID } from 'crypto';
import { loadFingerprint, saveFingerprint, deleteFingerprint } from '../core/store';

import { API } from '../core/constants';
import { withGate, gatePenalize } from '../core/gate';
import { egressFor, noteEgressFailure } from '../core/affinity';
import type { QuestListResponse, QuestShape } from '../core/interface';

const DISCORD_API = API;

// Updated to match aiko-chan-ai latest constants
let CLIENT_VERSION = '1.0.9236';
let BUILD_NUMBER = 539951;
let NATIVE_BUILD_NUMBER = 81687;
let buildVersionLoaded = false;

// Allow other modules to read the current build constants (kept in sync by
// initBuildVersion()).
export function getBuildVersion(): { clientVersion: string; buildNumber: number; nativeBuildNumber: number } {
	return { clientVersion: CLIENT_VERSION, buildNumber: BUILD_NUMBER, nativeBuildNumber: NATIVE_BUILD_NUMBER };
}

// Chrome version pool — keep updated with the latest stable releases.
// Source: https://chromereleases.googleblog.com (Chrome Stable channel)
// Latest as of Nov 2026: Chrome 158.0.8127.18 (Early Stable)
const CHROME_VERSIONS = [
	// Chrome 158 (Nov 2026 — latest stable)
	'158.0.8127.18',
	'158.0.8127.19',
	// Chrome 157 (Oct 2026)
	'157.0.6533.120',
	'157.0.6533.88',
	// Chrome 156 (Sep 2026 — still widely used)
	'156.0.6993.120',
	'156.0.6993.92',
	// Chrome 155 (Aug 2026)
	'155.0.6700.80',
];

// OS version pool — mix of Windows 10/11 variants (most common in real traffic)
const OS_VERSIONS = [
	'10.0.19045', // Windows 10 22H2 (most common Win10)
	'10.0.22621', // Windows 11 22H2
	'10.0.22631', // Windows 11 23H2
	'10.0.26100', // Windows 11 24H2 (newest)
];

// Discord's client_country / Accept-Language values to match real users
const LOCALES = ['en-US', 'en-GB', 'vi-VN', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'pt-BR', 'es-ES', 'zh-CN'];
const TIMEZONES = [
	'Asia/Saigon',
	'America/New_York',
	'America/Los_Angeles',
	'Europe/London',
	'Europe/Berlin',
	'Asia/Tokyo',
	'Asia/Seoul',
];

// Fetches discord.com/app, parses JS assets for buildNumber

async function updateLatestBuildVersion(): Promise<void> {
	try {
		console.log('[Discord] Fetching latest build number...');
		const response = await fetch('https://discord.com/app', {
			headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
		});
		if (!response.ok) {
			console.warn(`[Discord] Failed to fetch Discord page (${response.status})`);
			return;
		}
		const html = await response.text();

		// Find JS asset files
		const scripts = Array.from(html.match(/\/assets\/web.([a-f0-9]+)\.js/g) || []);
		if (!scripts || scripts.length === 0) {
			console.warn('[Discord] No JS assets found in HTML');
			return;
		}

		for (const scriptPath of scripts) {
			try {
				const assetUrl = `https://discord.com${scriptPath}`;
				const assetResponse = await fetch(assetUrl, {
					headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
				});
				if (!assetResponse.ok) continue;
				const jsContent = await assetResponse.text();

				// Match buildNumber pattern
				const match = jsContent.match(/buildNumber["\s:]+["\s]*(\d{5,7})/);
				if (match) {
					const newBuildNumber = parseInt(match[1], 10);
					if (newBuildNumber !== BUILD_NUMBER) {
						console.log(`[Discord] Build number updated: ${BUILD_NUMBER} → ${newBuildNumber}`);
						BUILD_NUMBER = newBuildNumber;
						// Try to extract client version too
						const versionMatch = jsContent.match(/client_version["\s:]+["\s]*([\d.]+)/);
						if (versionMatch) {
							CLIENT_VERSION = versionMatch[1];
							console.log(`[Discord] Client version updated: ${CLIENT_VERSION}`);
						}
					} else {
						console.log(`[Discord] Build number up-to-date: ${BUILD_NUMBER}`);
					}
					return;
				}
			} catch {
				continue;
			}
		}
		console.warn('[Discord] Build number not found in any JS assets');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error('[Discord] Error fetching build number:', errorMessage);
	}
}

/**
 * Initialize build version on startup + schedule refresh every 6 hours
 */
export async function initBuildVersion(): Promise<void> {
	if (buildVersionLoaded) return;
	buildVersionLoaded = true;
	await updateLatestBuildVersion();
	// Refresh every 6 hours
	setInterval(
		() => {
			updateLatestBuildVersion().catch((err) => {
				console.error('[Discord] Build version refresh failed:', err);
			});
		},
		6 * 60 * 60 * 1000,
	);
}

// Each token gets its own unique super-properties
// that persist across server restarts
// Deleted when token is deleted (cascade)

interface TokenFingerprint {
	launchId: string;
	launchSignature: string;
	heartbeatSessionId: string;
	sessionId: string;
	locale: string;
	timezone: string;
	chromeVersion: string;
	userAgent: string;
	osVersion: string;
}

function buildUserAgent(chromeVersion: string, osVersion: string): string {
	// Discord Client UA - REQUIRED for heartbeat/video-progress API
	// Regular Chrome UA gets 401 Unauthorized from Discord
	return `Mozilla/5.0 (Windows NT ${osVersion.split('.').slice(0, 2).join('.')}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${CLIENT_VERSION} Chrome/${chromeVersion} Electron/37.6.0 Safari/537.36`;
}

function generateFingerprintData(): Omit<TokenFingerprint, 'userAgent'> & { userAgent: string } {
	const chromeVersion = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
	const osVersion = OS_VERSIONS[Math.floor(Math.random() * OS_VERSIONS.length)];
	const userAgent = buildUserAgent(chromeVersion, osVersion);

	return {
		launchId: randomUUID(),
		launchSignature: randomUUID(),
		heartbeatSessionId: randomUUID(),
		sessionId: randomUUID(),
		locale: LOCALES[Math.floor(Math.random() * LOCALES.length)],
		timezone: TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)],
		chromeVersion,
		userAgent,
		osVersion,
	};
}

/**
 * Get or create the fingerprint of a token.
 * Reuses the stored one when present, so an account keeps a single identity.
 * If not → create new one with random UA, locale, timezone
 */
async function getOrCreateFingerprint(tokenId: string): Promise<TokenFingerprint> {
	// Reuse the fingerprint of an earlier run
	const existing = await loadFingerprint(tokenId);
	if (existing) {
		return {
			launchId: existing.launchId,
			launchSignature: existing.launchSignature,
			heartbeatSessionId: existing.heartbeatSessionId,
			sessionId: existing.sessionId,
			locale: existing.locale,
			timezone: existing.timezone,
			chromeVersion: existing.chromeVersion,
			userAgent: existing.userAgent,
			osVersion: existing.osVersion,
		};
	}

	// Create new fingerprint
	const data = generateFingerprintData();

	await saveFingerprint(tokenId, data);
	console.log(
		`[Discord] Created new fingerprint for token ${tokenId.slice(0, 12)}... Chrome/${data.chromeVersion} OS/${data.osVersion} locale/${data.locale}`,
	);

	return data;
}

/**
 * Drop the stored fingerprint of a token (expired or revoked token).
 */
export async function clearFingerprint(tokenId: string): Promise<void> {
	try {
		await deleteFingerprint(tokenId);
	} catch {
		// Ignore if not found
	}
}

/**
 * Build super-properties for a specific token
 * Each token has unique UUIDs, locale, timezone, UA
 */
export async function buildSuperProperties(tokenId: string): Promise<{ superProps: string; fp: TokenFingerprint }> {
	const fp = await getOrCreateFingerprint(tokenId);
	const props = {
		os: 'Windows',
		browser: 'Discord Client',
		release_channel: 'stable',
		client_version: CLIENT_VERSION,
		os_version: fp.osVersion,
		os_arch: 'x64',
		app_arch: 'x64',
		system_locale: fp.locale,
		has_client_mods: false,
		client_launch_id: fp.launchId,
		browser_user_agent: fp.userAgent,
		browser_version: fp.chromeVersion,
		os_sdk_version: fp.osVersion.split('.').pop() || '19045',
		client_build_number: BUILD_NUMBER,
		native_build_number: NATIVE_BUILD_NUMBER,
		client_event_source: null,
		launch_signature: fp.launchSignature,
		client_heartbeat_session_id: fp.heartbeatSessionId,
		client_app_state: 'focused',
	};
	return {
		superProps: Buffer.from(JSON.stringify(props)).toString('base64'),
		fp,
	};
}

// When gateway is connected, uses gateway's super-properties (CRITICAL for heartbeat/video-progress)
// When gateway is not connected, uses DB fingerprint or one-time fingerprint

import { getSuperProperties, getUserAgent, isGatewayReady } from './gateway';

export async function discordFetch(
	token: string,
	path: string,
	options: RequestInit = {},
	tokenId?: string,
): Promise<Response> {
	const url = path.startsWith('http') ? path : `${DISCORD_API}${path}`;

	let superProps: string;
	let userAgent: string;
	let locale: string;
	let timezone: string;

	if (tokenId && isGatewayReady(tokenId)) {
		// Gateway is connected → use gateway's super-properties (MUST match Identify payload)
		superProps = getSuperProperties(tokenId);
		userAgent = getUserAgent(tokenId);
		locale = 'en-US';
		timezone = 'Asia/Saigon';
	} else if (tokenId) {
		// No gateway session: reuse the stored fingerprint
		const built = await buildSuperProperties(tokenId);
		superProps = built.superProps;
		userAgent = built.fp.userAgent;
		locale = built.fp.locale;
		timezone = built.fp.timezone;
	} else {
		// No tokenId → generate one-time fingerprint (stateless)
		const oneTimeChrome = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
		const oneTimeOs = OS_VERSIONS[Math.floor(Math.random() * OS_VERSIONS.length)];
		const oneTimeUA = buildUserAgent(oneTimeChrome, oneTimeOs);
		superProps = Buffer.from(
			JSON.stringify({
				os: 'Windows',
				browser: 'Discord Client',
				release_channel: 'stable',
				client_version: CLIENT_VERSION,
				os_version: oneTimeOs,
				os_arch: 'x64',
				app_arch: 'x64',
				system_locale: 'en-US',
				has_client_mods: false,
				client_launch_id: randomUUID(),
				browser_user_agent: oneTimeUA,
				browser_version: oneTimeChrome,
				os_sdk_version: oneTimeOs.split('.').pop() || '19045',
				client_build_number: BUILD_NUMBER,
				native_build_number: NATIVE_BUILD_NUMBER,
				client_event_source: null,
				launch_signature: randomUUID(),
				client_heartbeat_session_id: randomUUID(),
				client_app_state: 'focused',
			}),
		).toString('base64');
		userAgent = oneTimeUA;
		locale = 'en-US';
		timezone = 'Asia/Saigon';
	}

	// Check for Android request header (aiko-style handling)
	const customHeaders = (options.headers as Record<string, string>) || {};
	const isAndroidRequest = customHeaders['AndroidRequest'] === 'true';
	// Remove AndroidRequest from headers (aiko does this — it's not a real HTTP header)
	delete customHeaders['AndroidRequest'];

	// Android uses different User-Agent and super-properties
	const androidUserAgent = 'Discord-Android/316011;RNA';
	const androidSuperProps = Buffer.from(
		JSON.stringify({
			os: 'Android',
			browser: 'Discord Android',
			device: 'b0q',
			system_locale: locale,
			has_client_mods: false,
			client_version: '316.11 - rn',
			release_channel: 'googleRelease',
			device_vendor_id: randomUUID(),
			design_id: 2,
			browser_user_agent: '',
			browser_version: '',
			os_version: '28',
			client_build_number: 5169,
			client_event_source: null,
			client_launch_id: randomUUID(),
			launch_signature: '1771754995045142953',
			client_app_state: 'active',
			client_heartbeat_session_id: randomUUID(),
		}),
	).toString('base64');

	const finalUserAgent = isAndroidRequest ? androidUserAgent : userAgent;
	const finalSuperProps = isAndroidRequest ? androidSuperProps : superProps;
	const finalBrowserVer = isAndroidRequest
		? '316'
		: finalUserAgent.match(/Chrome\/([\d.]+)/)?.[1] || '138.0.7204.251';

	const headers: Record<string, string> = {
		Authorization: token.replace(/^Bot\s+/i, ''),
		'Content-Type': 'application/json',
		'User-Agent': finalUserAgent,
		'x-super-properties': finalSuperProps,
		'x-debug-options': 'bugReporterEnabled',
		'x-discord-locale': locale,
		'x-discord-timezone': timezone,
		...(isAndroidRequest
			? {}
			: {
					origin: 'https://discord.com',
					referer: 'https://discord.com/channels/@me',
					pragma: 'no-cache',
					priority: 'u=1, i',
					'sec-ch-ua': `"Not)A;Brand";v="8", "Chromium";v="${finalBrowserVer.split('.')[0]}"`,
					'sec-ch-ua-mobile': '?0',
					'sec-ch-ua-platform': '"Windows"',
					'sec-fetch-dest': 'empty',
					'sec-fetch-mode': 'cors',
					'sec-fetch-site': 'same-origin',
				}),
		...customHeaders,
	};

	// Quest vùng khác cần đi qua proxy đúng quốc gia. Chỉ request được đánh dấu
	// proxyUrl mới rời khỏi kết nối trực tiếp, phần còn lại đi theo IP cố định của
	// tài khoản (affinity) và chịu cửa van chung để không dội IP.
	const { proxyUrl: forcedProxy, ...rest } = options as RequestInit & { proxyUrl?: string };

	const egress = forcedProxy ? { key: forcedProxy, proxyUrl: forcedProxy } : await egressFor(tokenId);

	const send = async (): Promise<Response> => {
		if (!egress.proxyUrl) return (await fetch(url, { ...rest, headers })) as Response;
		const { ProxyAgent, fetch: undiciFetch } = await import('undici');
		return (await undiciFetch(url, {
			...rest,
			headers,
			dispatcher: new ProxyAgent(egress.proxyUrl),
		} as Parameters<typeof undiciFetch>[1])) as unknown as Response;
	};

	const res = await withGate(egress.key, send).catch((error: Error) => {
		noteEgressFailure(egress.key, 60_000);
		throw error;
	});

	// Một IP bị 429 là chuyện của cả IP, không phải của riêng tài khoản: cho cả
	// khoá nghỉ đúng thời gian Discord yêu cầu (hoặc 5 giây nếu không nói).
	if (res.status === 429) {
		const retryAfter = Number(res.headers.get('retry-after') ?? '');
		const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
		gatePenalize(egress.key, waitMs);
	}

	return res;
}

/**
 * Check if a Discord API response indicates the token has expired
 * Discord returns 401 with specific error codes for expired/invalid tokens
 */
export function isTokenExpiredResponse(res: Response): boolean {
	return res.status === 401;
}

export async function verifyDiscordToken(token: string) {
	const res = await discordFetch(token, '/users/@me');
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Invalid token: ${res.status} ${text}`);
	}
	return res.json();
}

/**
 * Fetch quests from Discord API - returns full response including excluded_quests
 * Throws if quest enrollment is blocked
 */
export async function fetchDiscordQuests(token: string, tokenId?: string): Promise<QuestListResponse> {
	const res = await discordFetch(token, '/quests/@me', {}, tokenId);
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Failed to fetch quests: ${res.status} ${text}`);
	}
	const data = (await res.json()) as Record<string, any>;

	// Check if enrollment is blocked (aiko logic)
	if (data.quest_enrollment_blocked_until != null) {
		throw new Error(`Quest enrollment bị chặn đến ${data.quest_enrollment_blocked_until}`);
	}

	return {
		quests: (data.quests ?? []) as QuestShape[],
		excludedQuests: (data.excluded_quests ?? []) as QuestShape[],
	};
}

export async function getDiscordProfile(token: string, tokenId?: string, proxyUrl?: string) {
	// discordFetch nhận thêm proxyUrl ngoài RequestInit; ép kiểu để TS chấp nhận.
	const opts = (proxyUrl ? { proxyUrl } : {}) as RequestInit;
	const userRes = await discordFetch(token, '/users/@me', opts, tokenId);
	if (!userRes.ok) throw new Error('Failed to fetch profile');
	const user = (await userRes.json()) as Record<string, any>;

	// Fetch profile for banner data + settings for nsfw_allowed (age check)
	const [profileRes, settingsRes] = await Promise.all([
		discordFetch(token, `/users/${user.id}/profile`, opts, tokenId),
		discordFetch(token, '/users/@me/settings', opts, tokenId),
	]);
	const profileMeta = profileRes.ok ? await profileRes.json().catch(() => ({})) : {};
	const settingsData = settingsRes.ok ? await settingsRes.json().catch(() => ({})) : {};

	return {
		user,
		profile: profileMeta || {},
		guilds: [],
		connections: [],
		billing: [],
		subscriptions: [],
		settings: settingsData || {},
	};
}

/**
 * Enroll in a quest (aiko-style full body)
 * location: 11 = desktop, 12 = mobile
 * Passes traffic_metadata from quest data (aiko requirement)
 */
export async function enrollQuest(
	token: string,
	questId: string,
	isAndroid: boolean = false,
	tokenId?: string,
	questData?: Record<string, unknown>,
	proxyUrl?: string,
): Promise<Response> {
	const location = isAndroid ? 12 : 11;
	// aiko: pass traffic_metadata_raw and traffic_metadata_sealed from quest data
	const trafficMetadataRaw = (questData?.traffic_metadata_raw as string) || null;
	const trafficMetadataSealed = (questData?.traffic_metadata_sealed as string) || null;
	return discordFetch(
		token,
		`/quests/${questId}/enroll`,
		{
			method: 'POST',
			body: JSON.stringify({
				location,
				is_targeted: false,
				metadata_sealed: null,
				traffic_metadata_raw: trafficMetadataRaw,
				traffic_metadata_sealed: trafficMetadataSealed,
			}),
			headers: {
				AndroidRequest: isAndroid ? 'true' : 'false',
			},
			...(proxyUrl ? { proxyUrl } : {}),
		} as RequestInit & { proxyUrl?: string },
		tokenId,
	);
}

/**
 * Claim quest reward (aiko-style full body)
 * Uses rewards_config.platforms[0] and traffic_metadata from quest data
 */
export async function claimQuestReward(
	token: string,
	questId: string,
	questData?: Record<string, unknown>,
	tokenId?: string,
): Promise<Response> {
	// Extract platform from rewards_config (aiko logic)
	let platform = 1;
	let trafficMetadataRaw: string | null = null;
	let trafficMetadataSealed: string | null = null;

	if (questData) {
		const config = questData.config as Record<string, unknown> | undefined;
		const rewardsConfig = config?.rewards_config as Record<string, unknown> | undefined;
		const platforms = rewardsConfig?.platforms as number[] | undefined;
		if (platforms && platforms.length > 0) {
			platform = platforms[0];
		}
		trafficMetadataRaw = (questData.traffic_metadata_raw as string) || null;
		trafficMetadataSealed = (questData.traffic_metadata_sealed as string) || null;
	}

	const body: Record<string, unknown> = {
		platform,
		location: 11,
		is_targeted: false,
		metadata_raw: null,
		metadata_sealed: null,
	};
	if (trafficMetadataRaw) body.traffic_metadata_raw = trafficMetadataRaw;
	if (trafficMetadataSealed) body.traffic_metadata_sealed = trafficMetadataSealed;

	return discordFetch(
		token,
		`/quests/${questId}/claim-reward`,
		{
			method: 'POST',
			body: JSON.stringify(body),
		},
		tokenId,
	);
}

/**
 * Get virtual currency balance
 */
export async function getVirtualCurrencyBalance(token: string, tokenId?: string): Promise<number> {
	try {
		const res = await discordFetch(token, '/users/@me/virtual-currency/balance', {}, tokenId);
		if (!res.ok) return 0;
		const data = (await res.json()) as Record<string, any>;
		return Number(data.balance ?? 0);
	} catch {
		return 0;
	}
}
