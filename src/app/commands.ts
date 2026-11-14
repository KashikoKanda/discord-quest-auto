import { QuestWorker } from '../worker';
import { fetchDiscordQuests, getDiscordProfile } from '../api/client';
import { Quest } from '../quests/quest';
import { tokenIdFor } from '../core/config';
import { logger } from '../core/logger';
import type { CommandName, GatewayInteraction } from './interface';
import { editOriginal, EPHEMERAL, replyInteraction } from './rest';
import { getAccount, linkAccount, setAuto, unlinkAccount } from './store';

export const commandDefs = [
	{ name: 'help', description: 'Cách dùng bot quest', type: 1 },
	{
		name: 'link',
		description: 'Liên kết tài khoản Discord bằng token (tin nhắn riêng tư)',
		type: 1,
	},
	{ name: 'unlink', description: 'Gỡ tài khoản đã liên kết', type: 1 },
	{ name: 'quests', description: 'Xem quest kèm tiến trình', type: 1 },
	{
		name: 'run',
		description: 'Làm quest, theo dõi tiến trình ngay trong tin nhắn',
		type: 1,
		options: [
			{
				name: 'quest',
				description: 'Chỉ làm đúng quest này (bỏ trống = làm hết)',
				type: 3,
				required: false,
			},
		],
	},
	{ name: 'stop', description: 'Dừng quest đang chạy', type: 1 },
	{ name: 'claim', description: 'Nhận thưởng cho quest đã xong', type: 1 },
	{ name: 'status', description: 'Trạng thái và log gần nhất', type: 1 },
	{
		name: 'auto',
		description: 'Bật hoặc tắt vòng quét tự động mỗi 30 phút',
		type: 1,
		options: [
			{
				name: 'bat',
				description: 'Bật (true) hay tắt (false)',
				type: 5,
				required: true,
			},
		],
	},
] as const;

const LINK_MODAL = 'quest_link_modal';

function bar(percent: number): string {
	const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
	return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(percent)}%`;
}

function userIdOf(interaction: GatewayInteraction): string | null {
	return interaction.member?.user.id ?? interaction.user?.id ?? null;
}

function option(interaction: GatewayInteraction, name: string): string | null {
	const found = interaction.data?.options?.find((item) => item.name === name);
	if (found === undefined) return null;
	return String(found.value);
}

function embed(title: string, description: string, color = 0x5865f2): Record<string, unknown> {
	return {
		color,
		title,
		description,
		footer: { text: 'Discord Quest Auto' },
		timestamp: new Date().toISOString(),
	};
}

async function say(
	interaction: GatewayInteraction,
	title: string,
	description: string,
	color = 0x5865f2,
): Promise<void> {
	await replyInteraction(interaction.id, interaction.token, {
		type: 4,
		data: { embeds: [embed(title, description, color)], flags: EPHEMERAL },
	}).catch((error: Error) => logger.warn(error.message));
}

/** Bắt đầu một lần chạy và cập nhật tin nhắn theo log của engine. */
async function streamRun(interaction: GatewayInteraction, tokenId: string, questId?: string): Promise<void> {
	// Mặc định chạy song song: mọi quest cùng lúc. Có quest_id thì chỉ chạy quest đó.
	const started = QuestWorker.startQuests(tokenId, questId ?? undefined, questId ? false : true, 10000);
	if (!started.started) {
		await editOriginal(interaction.token, {
			embeds: [embed('Không chạy được', started.message, 0xfaa61a)],
		});
		return;
	}

	const deadline = Date.now() + 20 * 60 * 1000;
	let printed = 0;

	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 4000));

		const logs = QuestWorker.getLogs(tokenId);
		const lines = logs.slice(Math.max(0, logs.length - 8)).map((entry) => `${entry.message}`);
		printed = logs.length;

		const running = [...QuestWorker.getAllQuestProgress(tokenId).entries()].filter(
			([, item]) => item.status === 'running',
		);
		const status = QuestWorker.getStatus(tokenId);
		const head =
			running.length > 0
				? running.map(([questId, item]) => `▸ ${questId.slice(0, 8)} · ${bar(item.progress ?? 0)}`).join('\n')
				: status === 'running'
					? '▸ đang chuẩn bị quest tiếp theo'
					: '▸ không còn quest đang chạy';

		await editOriginal(interaction.token, {
			embeds: [
				embed(
					status === 'error' ? 'Quest gặp lỗi' : 'Đang làm quest',
					`${head}\n\n\`\`\`\n${lines.join('\n').slice(-1400) || 'chưa có log'}\n\`\`\``,
					status === 'error' ? 0xed4245 : 0x57f287,
				),
			],
		});

		if (status !== 'running' && running.length === 0) {
			await editOriginal(interaction.token, {
				embeds: [
					embed(
						'Xong lượt chạy',
						`${lines.slice(-6).join('\n') || 'không có log'}\n\nNhận thưởng: \`/claim\` · xem lại: \`/quests\``,
						0x57f287,
					),
				],
			});
			return;
		}
		if (printed === 0) break;
	}

	await editOriginal(interaction.token, {
		embeds: [embed('Vẫn đang chạy', 'Lượt này lâu hơn dự kiến. Xem tiến trình bằng `/status`.', 0xfaa61a)],
	});
}

async function handleLinkModal(interaction: GatewayInteraction): Promise<void> {
	const discordUserId = userIdOf(interaction);
	if (!discordUserId) return;

	const token = interaction.data?.components?.[0]?.components?.[0]?.value?.trim() ?? '';
	if (!token) {
		await say(interaction, 'Thiếu token', 'Bạn chưa dán token vào ô.', 0xed4245);
		return;
	}

	try {
		const profile = await getDiscordProfile(token);
		const username = profile.user?.username ?? 'không rõ';
		const account = linkAccount(discordUserId, token, username, profile.user?.id ?? '');
		QuestWorker.registerToken(account.tokenId, token, false);
		await say(
			interaction,
			'Đã liên kết',
			`Tài khoản **${username}** đã sẵn sàng.\nBắt đầu bằng \`/quests\` hoặc \`/run\`.`,
			0x57f287,
		);
	} catch {
		await say(
			interaction,
			'Token không dùng được',
			'Discord từ chối token này. Lấy token mới rồi `/link` lại.',
			0xed4245,
		);
	}
}

async function handleDeferredCommand(interaction: GatewayInteraction, command: CommandName): Promise<void> {
	const discordUserId = userIdOf(interaction) ?? '';
	const account = getAccount(discordUserId);

	if (!account) {
		await editOriginal(interaction.token, {
			embeds: [embed('Chưa liên kết', 'Dùng `/link` để dán token tài khoản trước đã.', 0xfaa61a)],
		});
		return;
	}

	QuestWorker.registerToken(account.tokenId, account.token, false);

	if (command === 'quests') {
		try {
			const { quests } = await fetchDiscordQuests(account.token, account.tokenId);
			const list = quests.map((item) => Quest.create(item));
			// Chỉ hiện quest chưa làm và đang làm; quest đã xong thì ẩn đi.
			const open = list.filter((quest) => quest.isOpen());
			// Quest "ẩn": đã xong chờ nhận hoặc đã hết hạn. Không đưa vào danh sách
			// chính, chỉ đếm và gọi tên vài cái để biết cần nhận gì.
			const waiting = list.filter((quest) => quest.isCompleted() && !quest.isClaimed());
			const expired = list.filter((quest) => quest.isExpired() && !quest.isCompleted());
			const lines = open.slice(0, 18).map((quest) => {
				const orbs = quest.orbs ? ` · ${quest.orbs} orbs` : '';
				return `▸ **${quest.name}**\n\u2003\`${quest.type}\` · ${quest.label()}${orbs}\n\u2003${bar(quest.progress)}`;
			});
			const body = lines.join('\n') || 'Không còn quest nào để làm.';
			const hiddenNames = waiting
				.slice(0, 6)
				.map((quest) => `▸ ${quest.name}`)
				.join('\n');
			const hiddenParts = [
				`✔ **${waiting.length}** quest đã xong chờ nhận`,
				expired.length ? `⌛ **${expired.length}** quest hết hạn chưa xong` : '',
			].filter(Boolean);
			const footer = hiddenParts.length
				? `\n\n**Ẩn** · ${hiddenParts.join(' · ')}${hiddenNames ? `\n${hiddenNames}` : ''}${
						waiting.length > 6 ? `\n… và ${waiting.length - 6} quest khác` : ''
					}\nNhận thưởng: \`/claim\``
				: '';
			await editOriginal(interaction.token, {
				embeds: [
					embed(
						`Quest của ${account.username} · ${open.length} cần làm`,
						`${body}${footer}`,
						open.length > 0 ? 0x5865f2 : 0x57f287,
					),
				],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await editOriginal(interaction.token, {
				embeds: [embed('Không lấy được quest', message.slice(0, 300), 0xed4245)],
			});
		}
		return;
	}

	if (command === 'run') {
		await streamRun(interaction, account.tokenId, option(interaction, 'quest') ?? undefined);
		return;
	}

	if (command === 'stop') {
		const result = QuestWorker.stopQuests(account.tokenId);
		await editOriginal(interaction.token, {
			embeds: [
				embed(
					result.stopped ? 'Đã dừng' : 'Không có gì để dừng',
					result.message,
					result.stopped ? 0x57f287 : 0xfaa61a,
				),
			],
		});
		return;
	}

	if (command === 'claim') {
		try {
			const result = await QuestWorker.claimAll(account.tokenId);
			if (result.total === 0) {
				await editOriginal(interaction.token, {
					embeds: [embed('Không có gì để nhận', 'Chưa có quest nào hoàn thành chờ thưởng.', 0xfaa61a)],
				});
				return;
			}
			const list = result.names
				.slice(0, 12)
				.map((name) => `▸ ${name}`)
				.join('\n');
			const more = result.names.length > 12 ? `\n… và ${result.names.length - 12} quest khác` : '';
			const note =
				result.captcha > 0
					? '\n\n**Discord chặn nhận thưởng bằng captcha.** Mở app Discord, vào Quests, bấm nhận cho các quest trên. Bot không vượt captcha.'
					: '';
			const title =
				result.claimed > 0 ? `Đã nhận ${result.claimed}/${result.total} quest` : 'Chưa nhận được quest nào';
			await editOriginal(interaction.token, {
				embeds: [embed(title, `${list}${more}${note}`, result.claimed > 0 ? 0x57f287 : 0xfaa61a)],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await editOriginal(interaction.token, {
				embeds: [embed('Nhận thưởng lỗi', message.slice(0, 300), 0xed4245)],
			});
		}
		return;
	}

	if (command === 'status') {
		const status = QuestWorker.getStatus(account.tokenId);
		const logs = QuestWorker.getLogs(account.tokenId).slice(-8);
		const progress = [...QuestWorker.getAllQuestProgress(account.tokenId).entries()];
		const lines = progress.map(
			([questId, item]) => `▸ \`${questId.slice(0, 8)}\` · ${bar(item.progress ?? 0)} · ${item.status}`,
		);
		await editOriginal(interaction.token, {
			embeds: [
				embed(
					`Trạng thái · ${account.username}`,
					`**${status}** · tự động: ${account.auto ? 'bật' : 'tắt'}\n${lines.join('\n')}\n\n\`\`\`\n${
						logs
							.map((entry) => entry.message)
							.join('\n')
							.slice(-1200) || 'chưa có log'
					}\n\`\`\``,
					status === 'error' ? 0xed4245 : status === 'running' ? 0x57f287 : 0x5865f2,
				),
			],
		});
		return;
	}

	if (command === 'auto') {
		const on = option(interaction, 'bat') === 'true';
		setAuto(discordUserId, on);
		await editOriginal(interaction.token, {
			embeds: [
				embed(
					on ? 'Đã bật tự động' : 'Đã tắt tự động',
					on ? 'Mỗi 30 phút bot tự quét quest còn thiếu cho bạn.' : 'Bot chỉ chạy khi bạn gọi `/run`.',
					on ? 0x57f287 : 0xfaa61a,
				),
			],
		});
		return;
	}
}

export async function handleInteraction(interaction: GatewayInteraction): Promise<void> {
	try {
		// MODAL_SUBMIT
		if (interaction.type === 5) {
			if (interaction.data?.custom_id === LINK_MODAL) await handleLinkModal(interaction);
			return;
		}
		if (interaction.type !== 2) return;

		const command = (interaction.data?.name ?? '') as CommandName;

		if (command === 'help') {
			await say(
				interaction,
				'Discord Quest Auto',
				[
					'`/link` dán token tài khoản (chỉ bạn thấy)',
					'`/quests` xem quest và tiến trình',
					'`/run [quest]` làm quest, tiến trình hiện ngay trong tin nhắn',
					'`/stop` dừng lượt đang chạy',
					'`/claim` nhận thưởng quest đã xong',
					'`/status` trạng thái và log gần nhất',
					'`/auto` bật hoặc tắt quét mỗi 30 phút',
					'`/unlink` gỡ tài khoản',
					'',
					'Quest chạy tuần tự, mỗi request cách nhau 1.5–3 giây.',
				].join('\n'),
			);
			return;
		}

		if (command === 'link') {
			const existing = getAccount(userIdOf(interaction) ?? '');
			if (existing) {
				await say(
					interaction,
					'Đã liên kết rồi',
					`Đang dùng tài khoản **${existing.username}**. Gỡ bằng \`/unlink\` nếu muốn đổi.`,
					0xfaa61a,
				);
				return;
			}
			await replyInteraction(interaction.id, interaction.token, {
				type: 9,
				data: {
					custom_id: LINK_MODAL,
					title: 'Liên kết tài khoản Discord',
					components: [
						{
							type: 1,
							components: [
								{
									type: 4,
									custom_id: 'token',
									label: 'Token tài khoản',
									style: 2,
									min_length: 20,
									max_length: 200,
									placeholder: 'Dán token, bot không hiện lại token này',
									required: true,
								},
							],
						},
					],
				},
			});
			return;
		}

		if (command === 'unlink') {
			const removed = unlinkAccount(userIdOf(interaction) ?? '');
			await say(
				interaction,
				removed ? 'Đã gỡ liên kết' : 'Chưa có gì để gỡ',
				removed ? `Tài khoản **${removed.username}** đã được gỡ khỏi bot.` : 'Bạn chưa `/link` tài khoản nào.',
				removed ? 0x57f287 : 0xfaa61a,
			);
			return;
		}

		// Các lệnh cần gọi Discord API → defer trước rồi sửa tin nhắn sau.
		await replyInteraction(interaction.id, interaction.token, { type: 5, data: { flags: EPHEMERAL } });
		await handleDeferredCommand(interaction, command);
	} catch (error) {
		logger.error(`Xử lý ${interaction.data?.name ?? 'interaction'} lỗi: ${(error as Error).message}`);
	}
}

export { tokenIdFor };
