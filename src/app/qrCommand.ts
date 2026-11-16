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

export async function handleQrCommand(interaction: GatewayInteraction): Promise<void> {
	const userId = interaction.member?.user.id ?? interaction.user?.id ?? '';

	const { startQrLogin } = await import('../api/qrAuth');

	/** Nút mở link đăng nhập; gán lại sau khi có fingerprint. */
	let loginButton: Record<string, unknown>[] = [];

	await editOriginal(interaction.token, { content: 'Hãy chờ' });

	let session: Awaited<ReturnType<typeof startQrLogin>>;
	try {
		session = await startQrLogin({
			onScanned: (username) => {
				editOriginal(interaction.token, {
					content: username ? `**${username}** Đang đăng nhập` : '**User** Đang đăng nhập',
					components: loginButton,
				}).catch(() => undefined);
			},
		});
	} catch (error) {
		await editOriginal(interaction.token, {
			content: `Không mở được phiên đăng nhập: ${(error as Error).message.slice(0, 300)}`,
		});
		return;
	}

	const link = `https://discord.com/ra/${session.fingerprint}`;
	loginButton = [
		{
			type: 1,
			components: [{ type: 2, style: 5, label: 'Đăng nhập', emoji: { name: '🔐' }, url: link }],
		},
	];

	// Chỉ gửi nút, không kèm mô tả.
	await editOriginal(interaction.token, { content: '', components: loginButton });

	let failure: string | null = null;
	const token = await session.wait.catch((error: Error) => {
		logger.warn(`QR đăng nhập thất bại: ${error.message}`);
		failure = error.message;
		return null;
	});

	if (!token) {
		await editOriginal(interaction.token, {
			content: `${(failure ?? 'Link đã hết hiệu lực.').slice(0, 400)}\nDùng \`/link\` dán token nếu cần ngay.`,
		});
		return;
	}

	try {
		const profile = (await getDiscordProfile(token, tokenIdFor(token))) as { user: Record<string, any> };
		const username = String(profile.user.username ?? 'tài khoản');
		const profileUserId = String(profile.user.id ?? '');
		linkAccount(userId, token, username, profileUserId);
		await editOriginal(interaction.token, {
			content: `Đã liên kết **${username}**. Thử \`/quests\` hoặc \`/hidden\`.`,
		});
	} catch (error) {
		await editOriginal(interaction.token, {
			content: `Đã lấy token nhưng không kiểm tra được tài khoản: ${(error as Error).message.slice(0, 300)}`,
		});
	}
}
