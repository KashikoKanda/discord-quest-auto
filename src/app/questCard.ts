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
const CARD_MAX_H = 720;
const CARD_MIN_H = 330;

/** Một quest thành một tấm ảnh riêng, giữ nguyên khung hình gốc của ảnh bìa. */
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

	const sourceWidth = meta?.width ?? 16;
	const sourceHeight = meta?.height ?? 9;
	const ratio = sourceWidth / sourceHeight;

	// Giữ nguyên khung hình gốc, chỉ giới hạn chiều rộng và chiều cao cho dễ xem.
	// Ảnh quá dẹt thì đệm nền mờ hai bên thay vì cắt mất nội dung.
	const width = CARD_MAX_W;
	const natural = Math.round(width / ratio);
	const height = Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, natural));

	const base = hero
		? await fitWhole(hero, width, height)
		: await sharp({ create: { width, height, channels: 3, background: { r: 32, g: 34, b: 44 } } })
				.png()
				.toBuffer();

	// Cỡ chữ co theo bề rộng để ảnh nhỏ vẫn cân đối.
	const padX = Math.round(width * 0.045);
	const nameFont = Math.round(width * 0.042);
	const metaFont = Math.round(width * 0.024);
	const noteFont = Math.round(width * 0.019);
	const badgeFont = Math.round(width * 0.023);
	const badgeW = Math.round(width * 0.12);
	const badgeH = Math.round(badgeFont * 1.9);
	const badgeX = width - badgeW - Math.round(width * 0.028);
	const badgeY = Math.round(width * 0.028);
	// Xếp chữ từ dưới lên, mỗi dòng cần chỗ cho cỡ chữ của chính nó.
	const noteGap = Math.round(noteFont * 0.9);
	const metaGap = noteGap + Math.round(metaFont * 1.5);
	const nameGap = metaGap + Math.round(nameFont * 1.15);

	const name = escapeXml(clip(quest.name, 44));
	const metaText = escapeXml(clip(metaLine(quest), 60));
	const note = options.note ? escapeXml(clip(options.note, 54)) : '';
	const badge = `${options.index + 1}/${options.total}`;

	const overlay = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
	<defs>
		<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
			<stop offset="45%" stop-color="#000000" stop-opacity="0"/>
			<stop offset="100%" stop-color="#000000" stop-opacity="0.9"/>
		</linearGradient>
	</defs>
	<rect width="${width}" height="${height}" fill="url(#shade)"/>
	<rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${badgeH / 2}" fill="#000000" fill-opacity="0.55"/>
	<text x="${badgeX + badgeW / 2}" y="${badgeY + badgeH * 0.68}" text-anchor="middle" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${badgeFont}" fill="#ffffff">${badge}</text>
	<text x="${padX}" y="${height - nameGap}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${nameFont}" font-weight="bold" fill="#ffffff">${name}</text>
	<text x="${padX}" y="${height - metaGap}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${metaFont}" fill="#d5d8e0">${metaText}</text>
	${note ? `<text x="${padX}" y="${height - noteGap}" font-family="DejaVu Sans, Noto Sans, Noto Sans Thai, Noto Sans CJK JP, sans-serif" font-size="${noteFont}" fill="#9aa0ad">${note}</text>` : ''}
</svg>`);

	return sharp(base)
		.composite([{ input: overlay, top: 0, left: 0 }])
		.png({ compressionLevel: 9 })
		.toBuffer();
}
