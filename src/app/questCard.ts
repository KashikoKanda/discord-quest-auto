/**
 * Ảnh tổng hợp danh sách quest.
 *
 * Discord chỉ cho một ảnh mỗi embed nên không xếp được lưới ảnh bằng embed. Thay
 * vào đó ghép ảnh bìa của từng quest thành một tấm PNG rồi gửi làm tệp đính kèm,
 * kiểu bảng chia ô như các trang tổng hợp sự kiện.
 */

import sharp from 'sharp';

const CDN = 'https://cdn.discordapp.com';
// Icon orbs thật của Discord (discordquest.com phục vụ sẵn dạng webp).
const ORBS_ICON = 'https://discordquest.com/discord/quests/orbs.webp';

export interface CardQuest {
	id: string;
	name: string;
	minutes: number;
	type: string;
	/** Nhãn vùng hoặc ghi chú ngắn hiển thị dưới tên. */
	tag: string;
	hero: string | null;
	/** Số orbs thưởng; 0 là không rõ. */
	orbs?: number;
	/** Tên phần quà Discord ghi, ví dụ "150 Orbs". */
	reward?: string;
	/** Đường dẫn ảnh quà trên CDN Discord, dạng quests/<id>/<file>.mp4 */
	rewardAsset?: string | null;
}

export interface GridResult {
	png: Buffer;
	width: number;
	height: number;
	/** Số quest thực sự có mặt trong ảnh. */
	drawn: number;
}

const CELL_W = 460;
const CELL_H = 250;
const GAP = 16;
const PAD = 24;
const HEADER_H = 74;

function escapeXml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Cắt chữ theo số ký tự ước lượng, thêm dấu ba chấm. */
function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Màu khung theo mức thưởng, để nhìn ảnh là biết quest đáng hay không. */
function rewardColor(orbs: number | undefined): string {
	const value = orbs ?? 0;
	if (value >= 500) return '#f0b232';
	if (value >= 250) return '#a78bfa';
	if (value >= 100) return '#60a5fa';
	if (value > 0) return '#4ade80';
	return '#3f4147';
}

function metaLine(quest: CardQuest): string {
	const type = quest.type.replace(/_/g, ' ').toLowerCase();
	// Chỉ giữ hai thứ người xem thật sự cần khi lướt: dài bao lâu, loại gì.
	return `${quest.minutes} phút · ${type}`;
}

function labelSvg(quest: CardQuest): Buffer {
	const name = escapeXml(clip(quest.name, 34));
	const meta = escapeXml(clip(metaLine(quest), 46));
	return Buffer.from(`
<svg width="${CELL_W}" height="${CELL_H}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
			<stop offset="38%" stop-color="#000000" stop-opacity="0"/>
			<stop offset="100%" stop-color="#000000" stop-opacity="0.88"/>
		</linearGradient>
	</defs>
	<rect width="${CELL_W}" height="${CELL_H}" fill="url(#fade)"/>
	<text x="18" y="${CELL_H - 52}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="27" font-weight="bold" fill="#ffffff">${name}</text>
	<text x="18" y="${CELL_H - 24}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="18" fill="#d5d8e0">${meta}</text>
</svg>`);
}

/**
 * Đưa ảnh bìa vào khung mà không cắt: nền là chính ảnh đó phóng to làm mờ, còn
 * ảnh thật nằm trọn ở giữa.
 */
async function fitWhole(hero: Buffer, width: number, height: number): Promise<Buffer> {
	const backdrop = await sharp(hero)
		.resize(width, height, { fit: 'cover' })
		.blur(26)
		.modulate({ brightness: 0.55 })
		.toBuffer()
		.catch(() => null);

	const front = await sharp(hero)
		.resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.toBuffer()
		.catch(() => null);

	if (!front) return backdrop ?? hero;
	if (!backdrop) return front;

	return sharp(backdrop)
		.composite([{ input: front, top: 0, left: 0 }])
		.toBuffer();
}

async function fetchHero(hero: string | null): Promise<Buffer | null> {
	if (!hero) return null;
	try {
		const res = await fetch(hero.startsWith('http') ? hero : `${CDN}/${hero}`, {
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) return null;
		return Buffer.from(await res.arrayBuffer());
	} catch {
		return null;
	}
}

/**
 * Ảnh quà thật của Discord; ?format=png đổi video/asset sang PNG.
 * Quest orbs không có asset riêng nên dùng icon orbs của Discord.
 */
async function fetchRewardAsset(path: string | null | undefined, size: number, orbs?: number): Promise<Buffer | null> {
	const url = path
		? path.startsWith('http')
			? path
			: `${CDN}/${path}?format=png`
		: orbs && orbs > 0
			? ORBS_ICON
			: null;
	if (!url) return null;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return null;
		const raw = Buffer.from(await res.arrayBuffer());
		return await sharp(raw)
			.resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png()
			.toBuffer();
	} catch {
		return null;
	}
}

async function buildCell(quest: CardQuest): Promise<Buffer> {
	const hero = await fetchHero(quest.hero);
	const base = hero ? await fitWhole(hero, CELL_W, CELL_H) : null;

	// Không có ảnh bìa thì dùng nền chuyển sắc để ô vẫn đọc được.
	const canvas = base
		? sharp(base)
		: sharp({
				create: {
					width: CELL_W,
					height: CELL_H,
					channels: 3,
					background: { r: 32, g: 34, b: 44 },
				},
			});

	return canvas
		.composite([{ input: labelSvg(quest), top: 0, left: 0 }])
		.png()
		.toBuffer();
}

/** Ghép tối đa `max` quest thành lưới ảnh. */
export async function renderQuestGrid(
	quests: CardQuest[],
	options: { title?: string; columns?: number; max?: number } = {},
): Promise<GridResult> {
	const columns = options.columns ?? 3;
	const max = options.max ?? columns * 3;
	const picked = quests.slice(0, max);
	const title = options.title ?? `Quest ẩn · ${picked.length}`;

	const cells: (Buffer | null)[] = [];
	for (let i = 0; i < picked.length; i += 1) {
		cells.push(await buildCell(picked[i]));
	}

	const rows = Math.max(1, Math.ceil(cells.length / columns));
	const width = PAD * 2 + columns * CELL_W + (columns - 1) * GAP;
	const height = PAD * 2 + HEADER_H + rows * CELL_H + (rows - 1) * GAP;

	const header = Buffer.from(`
<svg width="${width}" height="${HEADER_H}" xmlns="http://www.w3.org/2000/svg">
	<text x="${PAD}" y="${HEADER_H - 22}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="34" font-weight="bold" fill="#f2f3f5">${escapeXml(clip(title, 60))}</text>
</svg>`);

	const composites: { input: Buffer; top: number; left: number }[] = [{ input: header, top: PAD, left: 0 }];
	cells.forEach((cell, index) => {
		if (!cell) return;
		const row = Math.floor(index / columns);
		const column = index % columns;
		composites.push({
			input: cell,
			top: PAD + HEADER_H + row * (CELL_H + GAP),
			left: PAD + column * (CELL_W + GAP),
		});
	});

	const png = await sharp({
		create: {
			width,
			height,
			channels: 3,
			background: { r: 18, g: 19, b: 24 },
		},
	})
		.composite(composites)
		.png({ compressionLevel: 9 })
		.toBuffer();

	return { png, width, height, drawn: cells.filter(Boolean).length };
}

const CARD_MAX_W = 720;
const CARD_MAX_H = 900;

/**
 * Một quest thành một tấm ảnh riêng: ảnh bìa để nguyên khung, phần chữ nằm trên
 * dải nền riêng bên dưới nên không có viền đen hay khoảng trống thừa.
 */
export async function renderQuestCard(
	quest: CardQuest,
	options: { index: number; total: number; note?: string } = { index: 0, total: 1 },
): Promise<Buffer> {
	const hero = await fetchHero(quest.hero);
	const meta = hero
		? await sharp(hero)
				.metadata()
				.catch(() => null)
		: null;

	const ratio = (meta?.width ?? 16) / (meta?.height ?? 9);
	let width = CARD_MAX_W;
	let artHeight = Math.round(width / ratio);
	if (artHeight > CARD_MAX_H) {
		artHeight = CARD_MAX_H;
		width = Math.round(artHeight * ratio);
	}

	const padX = Math.round(width * 0.045);
	const nameFont = Math.round(width * 0.046);
	const metaFont = Math.round(width * 0.024);
	const noteFont = Math.round(width * 0.019);
	const badgeFont = Math.round(width * 0.023);
	const badgeW = Math.round(width * 0.12);
	const badgeH = Math.round(badgeFont * 1.9);
	const badgeX = width - badgeW - Math.round(width * 0.028);
	const badgeY = Math.round(width * 0.028);

	// Dải chữ hai dòng thật gọn: tên, rồi thời lượng và loại. Ghi chú (nếu có) là
	// kết quả nhận quest, đã nằm trong embed chứ không lặp lại trên ảnh.
	const subtitle = metaLine(quest);
	const panelH = Math.round(nameFont * 1.35 + metaFont * 2 + width * 0.018);
	const height = artHeight + panelH;

	const art = hero
		? await sharp(hero).resize(width, artHeight, { fit: 'fill' }).toBuffer()
		: await sharp({ create: { width, height: artHeight, channels: 3, background: { r: 32, g: 34, b: 44 } } })
				.png()
				.toBuffer();

	const name = escapeXml(clip(quest.name, 44));
	const metaText = escapeXml(clip(subtitle, 74));
	const badge = `${options.index + 1}/${options.total}`;

	// Khung viền + huy hiệu orbs: biểu tượng là vòng tròn phát sáng như orbs Discord.
	const accent = rewardColor(quest.orbs);
	const orbFont = Math.round(width * 0.026);
	const orbH = Math.round(orbFont * 1.9);
	const orbW = Math.round(width * 0.26);
	const orbX = Math.round(width * 0.028);
	const orbY = Math.round(width * 0.028);
	// Ưu tiên tên quà Discord trả về ("150 Orbs"), không có thì lấy con số.
	const orbText = (quest.reward || (quest.orbs && quest.orbs > 0 ? String(quest.orbs) : '')).slice(0, 22);

	const overlay = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<radialGradient id="orb" cx="35%" cy="30%" r="72%">
			<stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
			<stop offset="28%" stop-color="${accent}" stop-opacity="0.98"/>
			<stop offset="100%" stop-color="#1a1b20" stop-opacity="1"/>
		</radialGradient>
		<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="#000000" stop-opacity="0.55"/>
			<stop offset="45%" stop-color="#000000" stop-opacity="0"/>
		</linearGradient>
	</defs>
	<rect width="${width}" height="${artHeight}" fill="url(#shade)"/>
	<rect x="0" y="${artHeight}" width="${width}" height="${panelH}" fill="#14151a"/>
	<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="#000000" fill-opacity="0.6"/>
	<text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH * 0.68}" text-anchor="middle" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${badgeFont}" fill="#ffffff">${badge}</text>
	<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${accent}" stroke-width="3" rx="2"/>
	${
		orbText
			? `<rect x="${orbX}" y="${orbY}" width="${orbW}" height="${orbH}" rx="${orbH / 2}" fill="#000000" fill-opacity="0.62" stroke="${accent}" stroke-opacity="0.85"/>
	<circle cx="${orbX + orbH * 0.62}" cy="${orbY + orbH / 2}" r="${orbFont * 0.5}" fill="url(#orb)"/>
	<ellipse cx="${orbX + orbH * 0.62 - orbFont * 0.14}" cy="${orbY + orbH / 2 - orbFont * 0.16}" rx="${orbFont * 0.17}" ry="${orbFont * 0.12}" fill="#ffffff" fill-opacity="0.85"/>
	<text x="${orbX + orbH * 1.15}" y="${orbY + orbH * 0.69}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${orbFont}" font-weight="bold" fill="#ffffff">${orbText}</text>`
			: ''
	}
	<text x="${padX}" y="${artHeight + Math.round(nameFont * 1.3)}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${nameFont}" font-weight="bold" fill="#ffffff">${name}</text>
	<text x="${padX}" y="${artHeight + Math.round(nameFont * 1.3 + metaFont * 1.85)}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${metaFont}" fill="#c9ced8">${metaText}</text>
</svg>`);

	// Khung cuối = ảnh bìa phía trên + dải chữ phía dưới, không thêm khoảng trống.
	const layers: { input: Buffer; top: number; left: number }[] = [
		{ input: art, top: 0, left: 0 },
		{ input: overlay, top: 0, left: 0 },
	];

	// Ảnh quà thật của Discord đè lên chỗ quả cầu vẽ tay, nếu quest có asset.
	const iconSize = Math.round(orbH - 6);
	const rewardIcon = await fetchRewardAsset(quest.rewardAsset, iconSize, quest.orbs);
	if (rewardIcon) {
		layers.push({ input: rewardIcon, top: orbY + 3, left: orbX + 4 });
	}

	return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 21, b: 26 } } })
		.composite(layers)
		.png({ compressionLevel: 9 })
		.toBuffer();
}
