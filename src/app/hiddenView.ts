/**
 * Trình xem quest ẩn từng cái một.
 *
 * Mỗi tin nhắn là một quest với ảnh bìa riêng và ba nút: trở lại, nhận, tiếp.
 * Danh sách giữ trong bộ nhớ theo người dùng để bấm nút không phải tải lại danh mục.
 */

import type { HiddenQuest } from '../api/catalog';
import type { GatewayInteraction } from './interface';
import { renderQuestCard } from './questCard';
import { editOriginalWithFile, EPHEMERAL, followUp, replyInteraction } from './rest';
import { getAccount } from './store';
import { QuestWorker } from '../worker';
import { logger } from '../core/logger';

const MAX_AGE_MS = 15 * 60 * 1000;
const sessions = new Map<string, { quests: HiddenQuest[]; at: number }>();

/** Số phiên giữ cùng lúc; quá thì bỏ phiên cũ nhất để bộ nhớ không phình. */
const MAX_SESSIONS = 500;

export function rememberHidden(userId: string, quests: HiddenQuest[]): void {
	// Không giữ `raw` (toàn bộ config của quest, vài chục KB mỗi cái): lúc nhận quest
	// worker đọc lại từ danh mục đã cache, nên bản trong phiên chỉ cần phần hiển thị.
	const slim = quests.map((quest) => ({ ...quest, raw: {} }));
	sessions.set(userId, { quests: slim, at: Date.now() });

	for (const [key, value] of sessions) {
		if (Date.now() - value.at > MAX_AGE_MS) sessions.delete(key);
	}
	while (sessions.size > MAX_SESSIONS) {
		const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (!oldest) break;
		sessions.delete(oldest[0]);
	}
}

export function hiddenSession(userId: string): HiddenQuest[] {
	const found = sessions.get(userId);
	if (!found || Date.now() - found.at > MAX_AGE_MS) return [];
	return found.quests;
}

function cardFields(quest: HiddenQuest): { meta: string; note: string } {
	const region = quest.region;
	const area =
		region && region.isGlobal && region.include.length === 0
			? 'toàn cầu'
			: (region?.include ?? []).slice(0, 3).join(', ') || 'chưa rõ vùng';
	const meta = `${quest.minutes} phút · ${quest.type.replace(/_/g, ' ').toLowerCase()} · ${area}`;
	const note = `${quest.game || 'không rõ game'} · ${quest.reason}`;
	return { meta, note };
}

const CHUNK = 25;

/** Menu chọn nhanh: 25 quest quanh vị trí đang xem, bấm là nhảy thẳng tới. */
function pickMenu(quests: HiddenQuest[], index: number): Record<string, unknown> {
	const chunk = Math.floor(index / CHUNK);
	const from = chunk * CHUNK;
	const slice = quests.slice(from, from + CHUNK);
	const options = slice.map((quest, offset) => {
		const area =
			quest.region && quest.region.isGlobal && quest.region.include.length === 0
				? 'toàn cầu'
				: (quest.region?.include ?? []).slice(0, 2).join('/') || 'chưa rõ vùng';
		return {
			label: `${from + offset + 1}. ${quest.name}`.slice(0, 100),
			value: String(from + offset),
			description: `${quest.minutes} phút · ${quest.type.replace(/_/g, ' ').toLowerCase()} · ${area}`.slice(
				0,
				100,
			),
			default: from + offset === index,
		};
	});

	return {
		type: 1,
		components: [
			{
				type: 3,
				custom_id: 'hv|pick',
				placeholder: `Chọn quest (${from + 1}-${from + slice.length} trên ${quests.length})`,
				min_values: 1,
				max_values: 1,
				options,
			},
		],
	};
}

function buttons(questId: string, index: number, total: number, note?: string): Record<string, unknown>[] {
	return [
		{
			type: 1,
			components: [
				{
					type: 2,
					style: 2,
					label: 'Trở lại',
					emoji: { name: '◀' },
					custom_id: `hv|prev|${index}`,
					disabled: index <= 0,
				},
				{
					type: 2,
					style: 3,
					label: note ? 'Nhận lại' : 'Nhận quest',
					emoji: { name: '🎁' },
					custom_id: `hv|enroll|${index}`,
				},
				{
					type: 2,
					style: 2,
					label: 'Tiếp',
					emoji: { name: '▶' },
					custom_id: `hv|next|${index}`,
					disabled: index >= total - 1,
				},
				{
					// Nút link: mở đúng quest trong app Discord.
					type: 2,
					style: 5,
					label: 'Mở quest',
					url: `https://discord.com/quests/${questId}`,
				},
			],
		},
	];
}

/** Ảnh + phần chữ cho một trang. */
export async function hiddenPageBody(
	quests: HiddenQuest[],
	index: number,
	note?: string,
): Promise<Record<string, unknown> & { file: Buffer }> {
	const quest = quests[index];
	const fields = cardFields(quest);
	const png = await renderQuestCard(
		{
			id: quest.id,
			name: quest.name,
			minutes: quest.minutes,
			type: quest.type,
			tag: fields.note,
			hero: quest.hero,
		},
		{ index, total: quests.length, note: `${quest.game} · ${quest.reason}` },
	);

	const link = `https://discord.com/quests/${quest.id}`;
	const embed: Record<string, unknown> = {
		color: 0x5865f2,
		title: quest.name.slice(0, 240),
		url: link,
		description: `[\`${quest.type}\` · ${fields.meta}](${link})\n[\`${quest.id}\`](${link})`,
		image: { url: 'attachment://quest-hidden.png' },
		footer: { text: `Quest ẩn ${index + 1}/${quests.length}${note ? ` · ${note}` : ''}` },
		timestamp: new Date().toISOString(),
	};

	return {
		embeds: [embed],
		components: [pickMenu(quests, index), ...buttons(quest.id, index, quests.length, note)],
		attachments: [{ id: 0, filename: 'quest-hidden.png', description: quest.name.slice(0, 100) }],
		file: png,
	};
}

export async function sendHiddenPage(interactionToken: string, quests: HiddenQuest[], index: number, note?: string) {
	const { file, ...body } = await hiddenPageBody(quests, index, note);
	await editOriginalWithFile(interactionToken, body, { name: 'quest-hidden.png', data: file });
}

/** Bấm nút trên tin nhắn quest ẩn. */
export async function handleHiddenButton(interaction: GatewayInteraction): Promise<void> {
	const customId = interaction.data?.custom_id ?? '';
	const [, action, rawIndex] = customId.split('|');
	const userId = interaction.member?.user.id ?? interaction.user?.id ?? '';
	const account = getAccount(userId);
	const quests = hiddenSession(userId);

	// Xác nhận đã nhận nút để Discord không báo "tương tác thất bại".
	await replyInteraction(interaction.id, interaction.token, { type: 6 }).catch(() => null);

	if (!account || quests.length === 0) {
		await followUp(interaction.token, {
			embeds: [
				{
					color: 0xfaa61a,
					description: 'Danh sách đã hết hạn. Chạy lại `/hidden` để xem tiếp.',
				},
			],
			flags: EPHEMERAL,
		}).catch(() => null);
		return;
	}

	const index = Math.max(0, Math.min(quests.length - 1, Number(rawIndex) || 0));

	if (action === 'pick') {
		// Menu chọn nhanh gửi giá trị là chỉ số quest.
		const picked = Number(interaction.data?.values?.[0] ?? 0);
		const at = Math.max(0, Math.min(quests.length - 1, Number.isFinite(picked) ? picked : 0));
		await sendHiddenPage(interaction.token, quests, at).catch((error: Error) =>
			logger.warn(`Không cập nhật được trang quest ẩn: ${error.message}`),
		);
		return;
	}

	if (action === 'prev' || action === 'next') {
		const next = Math.max(0, Math.min(quests.length - 1, index + (action === 'next' ? 1 : -1)));
		await sendHiddenPage(interaction.token, quests, next).catch((error: Error) =>
			logger.warn(`Không cập nhật được trang quest ẩn: ${error.message}`),
		);
		return;
	}

	if (action === 'enroll') {
		const quest = quests[index];
		const result = await QuestWorker.enrollHidden(account.tokenId, quest.id).catch((error: Error) => ({
			success: false,
			message: error.message,
		}));
		await sendHiddenPage(
			interaction.token,
			quests,
			index,
			result.success ? '✔ đã nhận' : `✖ ${result.message}`,
		).catch((error: Error) => logger.warn(`Không cập nhật được trang quest ẩn: ${error.message}`));
		return;
	}
}

export function isHiddenButton(customId: string): boolean {
	return customId.startsWith('hv|');
}
