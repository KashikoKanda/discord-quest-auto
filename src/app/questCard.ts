/**
 * Ảnh tổng hợp danh sách quest.
 *
 * Discord chỉ cho một ảnh mỗi embed nên không xếp được lưới ảnh bằng embed. Thay
 * vào đó ghép ảnh bìa của từng quest thành một tấm PNG rồi gửi làm tệp đính kèm,
 * kiểu bảng chia ô như các trang tổng hợp sự kiện.
 */

import sharp from 'sharp';

const CDN = 'https://cdn.discordapp.com';

export interface CardQuest {
	id: string;
	name: string;
	minutes: number;
	type: string;
	/** Nhãn vùng hoặc ghi chú ngắn hiển thị dưới tên. */
	tag: string;
	hero: string | null;
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

function metaLine(quest: CardQuest): string {
	const type = quest.type.replace(/_/g, ' ').toLowerCase();
	return `${quest.minutes}m · ${type} · ${quest.tag}`;
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

async function buildCell(quest: CardQuest): Promise<Buffer> {
	const hero = await fetchHero(quest.hero);
	const base = hero
		? await sharp(hero)
				.resize(CELL_W, CELL_H, { fit: 'cover', position: 'centre' })
				.toBuffer()
				.catch(() => null)
		: null;

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

const CARD_W = 900;
const CARD_H = 500;

/** Một quest thành một tấm ảnh riêng, kèm số thứ tự. */
export async function renderQuestCard(
	quest: CardQuest,
	options: { index: number; total: number; note?: string } = { index: 0, total: 1 },
): Promise<Buffer> {
	const hero = await fetchHero(quest.hero);
	const subject =
		hero &&
		(await sharp(hero)
			.metadata()
			.catch(() => null))
			? sharp(hero)
			: sharp({
					create: {
						width: CARD_W,
						height: CARD_H,
						channels: 3,
						background: { r: 32, g: 34, b: 44 },
					},
				});

	const base = await subject.resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' }).toBuffer();

	const name = escapeXml(clip(quest.name, 44));
	const meta = escapeXml(clip(metaLine(quest), 60));
	const note = options.note ? escapeXml(clip(options.note, 54)) : '';

	const overlay = Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
			<stop offset="30%" stop-color="#000000" stop-opacity="0"/>
			<stop offset="100%" stop-color="#000000" stop-opacity="0.92"/>
		</linearGradient>
	</defs>
	<rect width="${CARD_W}" height="${CARD_H}" fill="url(#shade)"/>
	<rect x="${CARD_W - 128}" y="24" width="104" height="40" rx="20" fill="#000000" fill-opacity="0.55"/>
	<text x="${CARD_W - 76}" y="51" text-anchor="middle" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="20" fill="#ffffff">${options.index + 1}/${options.total}</text>
	<text x="36" y="${CARD_H - 78}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="40" font-weight="bold" fill="#ffffff">${name}</text>
	<text x="36" y="${CARD_H - 40}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="22" fill="#d5d8e0">${meta}</text>
	${note ? `<text x="36" y="${CARD_H - 12}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="18" fill="#9aa0ad">${note}</text>` : ''}
</svg>`);

	return sharp(base)
		.composite([{ input: overlay, top: 0, left: 0 }])
		.png({ compressionLevel: 9 })
		.toBuffer();
}
