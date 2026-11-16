/**
 * Lệnh /qr: đăng nhập bằng mã QR, không phải dán token.
 *
 * Tin nhắn chỉ người gõ lệnh thấy. Khi điện thoại quét và xác nhận, bot nhận
 * token, lưu tài khoản rồi sửa lại chính tin nhắn đó.
 */

import type { GatewayInteraction } from './interface';
import { editOriginal, EPHEMERAL, followUp } from './rest';
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

	const link = `https://discord.com/ra/${session.fingerprint}`;

	await editOriginal(interaction.token, {
		embeds: [
			{
				color: 0x5865f2,
				title: 'Đăng nhập Discord',
				description: [
					'Bấm nút bên dưới để mở Discord và xác nhận đăng nhập.',
					'',
					'**Trên điện thoại:** mở app → bấm nút → **Xác nhận**.',
					'**Trên máy tính:** bấm nút, Discord sẽ mở trang xác nhận.',
					'',
					`Hoặc mở link này: ${link}`,
				].join('\n'),
				footer: {
					text: `Hết hạn sau 2 phút · IP: ${session.ip ?? 'không xác định'} (${session.ipNote})`,
				},
			},
		],
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 5,
						label: 'Đăng nhập Discord',
						emoji: { name: '🔐' },
						url: link,
					},
				],
			},
		],
	});

	let failure: string | null = null;
	const token = await session.wait.catch((error: Error) => {
		logger.warn(`QR đăng nhập thất bại: ${error.message}`);
		failure = error.message;
		return null;
	});

	if (!token) {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: 0xed4245,
					title: 'Chưa lấy được token',
					description: `${(failure ?? 'Mã QR hết hiệu lực.').slice(0, 400)}\n\nDùng \`/link\` dán token nếu cần ngay.`,
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
