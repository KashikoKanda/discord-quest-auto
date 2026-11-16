/**
 * Lệnh /login: đăng nhập bằng một nút mở link xác nhận của Discord.
 *
 * Tin nhắn chỉ người gõ lệnh thấy. Khi người dùng xác nhận trên app, bot nhận
 * token, lưu tài khoản rồi sửa lại chính tin nhắn đó.
 */

import type { GatewayInteraction } from './interface';
import { editOriginal } from './rest';
import { linkAccount } from './store';
import { getDiscordProfile } from '../api/client';
import { tokenIdFor } from '../core/config';
import { logger } from '../core/logger';

const BLURPLE = 0x5865f2;
const AMBER = 0xfaa61a;
const GREEN = 0x57f287;
const RED = 0xed4245;

export async function handleQrCommand(interaction: GatewayInteraction): Promise<void> {
	const userId = interaction.member?.user.id ?? interaction.user?.id ?? '';
	const { startQrLogin } = await import('../api/qrAuth');

	/** Nút mở link đăng nhập, có sau khi biết fingerprint. */
	let button: Record<string, unknown>[] = [];
	/** Tên tài khoản đã xác nhận trên app, dùng khi trạng thái quét tới sớm. */
	let scanned: string | null = null;

	const waiting = async () =>
		editOriginal(interaction.token, {
			embeds: [
				{
					color: BLURPLE,
					title: 'Đăng nhập tài khoản',
					description: '⏳ Hãy chờ trong giây lát…',
				},
			],
		});

	const showScanned = async () =>
		editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: '🔐 Đang đăng nhập',
					description: `${scanned ? `**${scanned}**` : '**User**'} đã xác nhận, đang lấy token…`,
				},
			],
			components: button,
		});

	await waiting();

	let session: Awaited<ReturnType<typeof startQrLogin>>;
	try {
		session = await startQrLogin({
			onScanned: (username) => {
				// Có thể tới trước cả lúc tin nhắn kịp hiện nút; giữ lại để áp sau.
				scanned = username ?? 'User';
				if (button.length > 0) showScanned().catch(() => undefined);
			},
		});
	} catch (error) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: RED,
					title: '❌ Không mở được phiên đăng nhập',
					description: (error as Error).message.slice(0, 300),
				},
			],
		});
		return;
	}

	const link = `https://discord.com/ra/${session.fingerprint}`;

	button = [
		{
			type: 1,
			components: [{ type: 2, style: 5, label: 'Đăng nhập ngay', emoji: { name: '🔐' }, url: link }],
		},
	];

	// Chỉ gửi nút, không kèm chữ nào.
	await editOriginal(interaction.token, { content: '', components: button });

	// Nếu người dùng xác nhận trước khi nút kịp hiện, cập nhật lại cho khớp trạng thái.
	if (scanned) await showScanned().catch(() => undefined);

	let failure: string | null = null;
	const token = await session.wait.catch((error: Error) => {
		logger.warn(`Đăng nhập thất bại: ${error.message}`);
		failure = error.message;
		return null;
	});

	if (!token) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: 'Link đã hết hiệu lực',
					description: `${(failure ?? 'Hết 2 phút chờ xác nhận.').slice(0, 300)}\nChạy lại \`/login\`, hoặc dùng \`/link\` nếu cần ngay.`,
				},
			],
		});
		return;
	}

	let username = 'tài khoản';
	try {
		const profile = (await getDiscordProfile(token, tokenIdFor(token))) as { user: Record<string, any> };
		username = String(profile.user.username ?? 'tài khoản');
		linkAccount(userId, token, username, String(profile.user.id ?? ''));
	} catch (error) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: RED,
					title: 'Đã lấy token nhưng chưa kiểm tra được tài khoản',
					description: (error as Error).message.slice(0, 300),
				},
			],
		});
		return;
	}

	await editOriginal(interaction.token, {
		embeds: [
			{
				color: GREEN,
				title: '✅ Đăng nhập thành công',
				description: `Đang dùng **${username}**.\nThử \`/quests\` hoặc \`/hidden\`.`,
			},
		],
	});
}
