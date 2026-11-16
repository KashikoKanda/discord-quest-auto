/**
 * Lệnh /qr: đăng nhập bằng mã QR, không phải dán token.
 *
 * Tin nhắn chỉ người gõ lệnh thấy. Khi điện thoại quét và xác nhận, bot nhận
 * token, lưu tài khoản rồi sửa lại chính tin nhắn đó.
 */

import type { GatewayInteraction } from './interface';
import { editOriginal, editOriginalWithFile, EPHEMERAL, followUp } from './rest';
import { linkAccount } from './store';
import { getDiscordProfile } from '../api/client';
import { tokenIdFor } from '../core/config';
import { logger } from '../core/logger';

export async function handleQrCommand(interaction: GatewayInteraction): Promise<void> {
	const userId = interaction.member?.user.id ?? interaction.user?.id ?? '';

	const { startQrLogin } = await import('../api/qrAuth');

	await editOriginal(interaction.token, {
		embeds: [{ color: 0x5865f2, description: 'Đang tạo mã QR...' }],
	});

	let session: Awaited<ReturnType<typeof startQrLogin>>;
	try {
		session = await startQrLogin({
			onScanned: (username) => {
				followUp(interaction.token, {
					embeds: [
						{
							color: 0xfaa61a,
							description: username
								? `Đã quét bằng **${username}**. Bấm **Xác nhận** trên điện thoại.`
								: 'Đã quét. Bấm **Xác nhận** trên điện thoại.',
						},
					],
					flags: EPHEMERAL,
				}).catch(() => undefined);
			},
		});
	} catch (error) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: 0xed4245,
					title: 'Không mở được phiên QR',
					description: (error as Error).message.slice(0, 300),
				},
			],
		});
		return;
	}

	await editOriginalWithFile(
		interaction.token,
		{
			embeds: [
				{
					color: 0x5865f2,
					title: 'Quét mã bằng app Discord',
					description: [
						'Mở Discord trên điện thoại → **Bạn** → biểu tượng quét mã ở góc trên.',
						'',
						`Mã hết hạn sau 2 phút. Hoặc mở: https://discord.com/ra/${session.fingerprint}`,
					].join('\n'),
					image: { url: 'attachment://discord-qr.png' },
					footer: { text: 'Không chia sẻ mã này cho ai' },
				},
			],
			attachments: [{ id: 0, filename: 'discord-qr.png', description: 'Mã QR đăng nhập Discord' }],
		},
		{ name: 'discord-qr.png', data: session.png },
	);

	const token = await session.wait.catch((error: Error) => {
		logger.warn(`QR đăng nhập thất bại: ${error.message}`);
		return null;
	});

	if (!token) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: 0xfaa61a,
					title: 'Mã QR hết hiệu lực',
					description: 'Chạy lại `/qr` để lấy mã mới.',
				},
			],
		});
		return;
	}

	try {
		const profile = (await getDiscordProfile(token, tokenIdFor(token))) as { user: Record<string, any> };
		const username = String(profile.user.username ?? 'tài khoản');
		const profileUserId = String(profile.user.id ?? '');
		linkAccount(userId, token, username, profileUserId);
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: 0x57f287,
					title: 'Đã liên kết',
					description: `Đang dùng tài khoản **${username}**.\nThử ngay: \`/quests\` hoặc \`/hidden\`.`,
				},
			],
		});
	} catch (error) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: 0xed4245,
					title: 'Đã lấy token nhưng không kiểm tra được tài khoản',
					description: (error as Error).message.slice(0, 300),
				},
			],
		});
	}
}
