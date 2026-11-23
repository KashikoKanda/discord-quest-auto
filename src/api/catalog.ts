/**
 * Danh mục quest công khai.
 *
 * Discord chỉ trả về những quest mà tài khoản nhìn thấy (`/quests/@me`). Quest bị
 * giới hạn vùng hoặc không nhắm tới tài khoản sẽ biến mất khỏi danh sách đó dù vẫn
 * tồn tại — gọi là quest ẩn. Trang discordquest.com công bố toàn bộ danh mục kèm
 * vùng áp dụng, nên đây là nguồn để phát hiện quest ẩn và thử nhận bằng id.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const CATALOG_URL = 'https://api.discordquest.com/api/quests';
const REGIONS_URL = 'https://api.discordquest.com/api/regions';
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const CACHE_MS = 10 * 60 * 1000;
// Danh mục nằm sau Cloudflare và thỉnh thoảng trả 503 hàng loạt. Giữ bản lưu trên
// đĩa để lệnh vẫn có dữ liệu dùng khi lần tải mới thất bại.
const DISK_CACHE = '.quest-catalog.json';
const DISK_TTL_MS = 6 * 60 * 60 * 1000;

export interface CatalogQuest {
	id: string;
	name: string;
	game: string;
	publisher: string;
	type: string;
	minutes: number;
	expiresAt: string;
	startsAt: string;
	applicationId: string | null;
	link: string | null;
	orbs: number;
	/** Tên phần quà Discord ghi trong rewards_config, ví dụ "150 Orbs". */
	reward: string;
	/** Đường dẫn ảnh bìa trên cdn.discordapp.com, ví dụ quests/<id>/<file>.jpg */
	hero: string | null;
	raw: Record<string, unknown>;
}

export interface QuestRegion {
	isGlobal: boolean;
	include: string[];
	exclude: string[];
	ageGate: boolean;
}

export interface HiddenQuest extends CatalogQuest {
	region: QuestRegion | null;
	/** Nhận được từ quốc gia đang xét hay không. */
	enrollable: boolean;
	/** Lý do không nhận được, khi enrollable = false. */
	reason: string;
}

let catalogCache: { at: number; quests: CatalogQuest[] } | null = null;

type SlimQuest = Omit<CatalogQuest, 'raw'>;

function readDisk(): { at: number; quests: SlimQuest[] } | null {
	try {
		const text = readFileSync(DISK_CACHE, 'utf8');
		const data = JSON.parse(text) as { at: number; quests: SlimQuest[] };
		if (!Array.isArray(data.quests)) return null;
		return data;
	} catch {
		return null;
	}
}

function writeDisk(quests: CatalogQuest[]): void {
	try {
		const slim: SlimQuest[] = quests.map(({ raw: _raw, ...rest }) => rest);
		writeFileSync(DISK_CACHE, JSON.stringify({ at: Date.now(), quests: slim }));
	} catch {
		/* không ghi được thì thôi, lần sau tải lại */
	}
}
let regionCache: { at: number; map: Map<string, QuestRegion> } | null = null;

async function getJson(url: string): Promise<unknown> {
	// Máy chủ danh mục đứng sau Cloudflare và trả 1102 khi bị gọi dồn, nên thử lại
	// một lần sau khi chờ, rồi mới báo lỗi cho người dùng.
	const waits = [2000, 6000, 12000];
	for (let attempt = 0; attempt <= waits.length; attempt += 1) {
		// Cloudflare trước máy chủ danh mục trả 503 cho request trần (chỉ Accept + UA).
		// Gửi kèm bộ header như trình duyệt thì trang trả bình thường.
		const res = await fetch(url, {
			headers: {
				Accept: 'application/json, text/plain, */*',
				'User-Agent': UA,
				'Accept-Language': 'en-US,en;q=0.9',
				Referer: 'https://discordquest.com/',
				Origin: 'https://discordquest.com',
				'sec-ch-ua': '"Chromium";v="138", "Not(A:Brand";v="24"',
				'sec-ch-ua-mobile': '?0',
				'sec-ch-ua-platform': '"Windows"',
			},
			signal: AbortSignal.timeout(45_000),
		});
		const text = await res.text();
		if (res.ok && text.trimStart().startsWith('{')) {
			return JSON.parse(text);
		}
		if (res.ok && text.trimStart().startsWith('[')) {
			return JSON.parse(text);
		}
		if (attempt === waits.length) {
			throw new Error(`Danh mục quest không phản hồi (${res.status}): ${text.slice(0, 80)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
	}
	throw new Error('Danh mục quest không phản hồi');
}

function questType(raw: Record<string, unknown>): string {
	const config = (raw.config ?? {}) as Record<string, unknown>;
	const v2 = (config.task_config_v2 ?? {}) as { tasks?: Record<string, unknown> };
	const v1 = (config.task_config ?? {}) as { tasks?: Record<string, unknown> };
	const tasks = v2.tasks ?? v1.tasks ?? {};
	const known = [
		'WATCH_VIDEO',
		'WATCH_VIDEO_ON_MOBILE',
		'PLAY_ON_DESKTOP',
		'PLAY_ON_XBOX',
		'PLAY_ON_PLAYSTATION',
		'STREAM_ON_DESKTOP',
		'PLAY_ACTIVITY',
		'ACHIEVEMENT_IN_ACTIVITY',
	];
	for (const name of known) {
		if (tasks[name] != null) return name;
	}
	const first = Object.keys(tasks)[0];
	return first ?? 'UNKNOWN';
}

function taskSeconds(raw: Record<string, unknown>): number {
	const config = (raw.config ?? {}) as Record<string, unknown>;
	const v2 = (config.task_config_v2 ?? {}) as { tasks?: Record<string, { target?: number }> };
	const v1 = (config.task_config ?? {}) as { tasks?: Record<string, { target?: number }> };
	const tasks = { ...(v1.tasks ?? {}), ...(v2.tasks ?? {}) };
	const first = Object.values(tasks)[0];
	return first?.target ?? 0;
}

function normalize(raw: Record<string, unknown>): CatalogQuest {
	const config = (raw.config ?? {}) as Record<string, any>;
	const messages = (config.messages ?? {}) as Record<string, string>;
	const application = (config.application ?? {}) as Record<string, string>;
	const reward = config.rewards_config?.rewards?.[0] ?? {};
	return {
		id: String(raw.id ?? config.id ?? ''),
		name: messages.quest_name ?? String(raw.id ?? ''),
		game: messages.game_title ?? application.name ?? '',
		publisher: messages.game_publisher ?? '',
		type: questType(raw),
		minutes: Math.ceil(taskSeconds(raw) / 60),
		expiresAt: String(config.expires_at ?? ''),
		startsAt: String(config.starts_at ?? ''),
		applicationId: application.id ?? null,
		link: application.link ?? null,
		orbs: Number(reward.orb_quantity ?? 0) || 0,
		reward: String((reward.messages as Record<string, string> | undefined)?.name ?? '') || '',
		hero: (config.assets?.hero as string | undefined) ?? null,
		raw,
	};
}

/** Danh mục quest còn hiệu lực, đã bỏ quest hết hạn và quest thử nghiệm. */
export async function fetchCatalog(): Promise<CatalogQuest[]> {
	if (catalogCache && Date.now() - catalogCache.at < CACHE_MS) return catalogCache.quests;

	let data: Record<string, unknown>[];
	try {
		const fetched = (await getJson(CATALOG_URL)) as Record<string, unknown>[];
		if (!Array.isArray(fetched)) throw new Error('Danh mục quest trả về dữ liệu lạ');
		data = fetched;
	} catch (err) {
		const disk = readDisk();
		if (disk && Date.now() - disk.at < DISK_TTL_MS) {
			catalogCache = { at: Date.now(), quests: disk.quests.map((quest) => ({ ...quest, raw: {} })) };
			return catalogCache.quests;
		}
		throw err;
	}

	const now = Date.now();
	const skip = ['[TEST] Cloud', 'Tiered Rewards V2', 'Sky Runners V2'];
	const quests = data
		.filter((raw) => {
			const config = (raw.config ?? {}) as Record<string, unknown>;
			const expires = config.expires_at as string | undefined;
			if (!expires) return false;
			const name = ((config.messages ?? {}) as Record<string, string>).quest_name ?? '';
			if (skip.includes(name)) return false;
			return new Date(expires).getTime() > now;
		})
		.map(normalize)
		.filter((quest) => quest.id !== '');

	catalogCache = { at: Date.now(), quests };
	writeDisk(quests);
	return quests;
}

/** Vùng áp dụng của từng quest. Phần này không bắt buộc: lỗi thì coi như toàn cầu. */
export async function fetchRegions(): Promise<Map<string, QuestRegion>> {
	if (regionCache && Date.now() - regionCache.at < CACHE_MS) return regionCache.map;

	const map = new Map<string, QuestRegion>();
	try {
		const data = (await getJson(REGIONS_URL)) as { quests?: Record<string, any>[] };
		for (const item of data.quests ?? []) {
			const regions = item.regions;
			let include: string[] = [];
			let exclude: string[] = [];
			if (Array.isArray(regions)) {
				include = regions.filter((code: string) => code !== '');
			} else if (regions && typeof regions === 'object') {
				if (Array.isArray(regions.include)) include = regions.include.filter((code: string) => code !== '');
				if (Array.isArray(regions.exclude)) exclude = regions.exclude.filter((code: string) => code !== '');
			}
			map.set(String(item.id), {
				isGlobal: Boolean(item.is_global),
				include,
				exclude,
				ageGate: Boolean(item.show_age_gate),
			});
		}
	} catch {
		// Không có dữ liệu vùng thì vẫn hiện được danh sách quest ẩn.
	}

	regionCache = { at: Date.now(), map };
	return map;
}

/**
 * Quest có trong danh mục công khai mà tài khoản chưa có.
 *
 * Không lọc theo vùng: người dùng muốn thấy hết, còn việc nhận được hay không thì
 * để lúc nhận mới biết (hoặc nhờ proxy đúng vùng). `blocked` chỉ là gợi ý.
 */
export async function fetchHiddenQuests(ownedIds: Set<string>, country: string): Promise<HiddenQuest[]> {
	const catalog = await fetchCatalog();
	const regions = await fetchRegions();
	const code = country.toUpperCase();

	return catalog
		.filter((quest) => !ownedIds.has(quest.id))
		.map((quest) => {
			const region = regions.get(quest.id) ?? null;
			if (region === null) {
				return { ...quest, region, enrollable: false, reason: 'chưa rõ vùng' };
			}
			if (region.ageGate) {
				return { ...quest, region, enrollable: false, reason: 'cần xác minh tuổi' };
			}
			if (region.exclude.includes(code)) {
				return { ...quest, region, enrollable: false, reason: `loại trừ ${code}` };
			}
			if (region.isGlobal && region.include.length === 0) {
				return { ...quest, region, enrollable: true, reason: 'toàn cầu' };
			}
			if (region.include.includes(code)) {
				return { ...quest, region, enrollable: true, reason: `vùng ${code}` };
			}
			if (region.include.length === 0) {
				return { ...quest, region, enrollable: true, reason: 'mở' };
			}
			return { ...quest, region, enrollable: false, reason: region.include.slice(0, 3).join('/') };
		})
		.sort((a, b) => a.minutes - b.minutes || a.name.localeCompare(b.name));
}

/** Quốc gia cần cho proxy khi nhận quest này, null nếu không rõ. */
export function regionCountry(quest: HiddenQuest): string | null {
	if (quest.enrollable) return null;
	const include = quest.region?.include ?? [];
	return include.length === 1 ? include[0] : (include[0] ?? null);
}

export function resetCatalogCache(): void {
	catalogCache = null;
	regionCache = null;
}
