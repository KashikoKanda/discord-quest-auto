/**
 * Lệnh /login: đăng nhập bằng một nút mở link xác nhận của Discord.
 *
 * Tin nhắn chỉ người gõ lệnh thấy. Khi người dùng xác nhận trên app, bot nhận
 * token, lưu tài khoản rồi sửa lại chính tin nhắn đó.
 */

import type { GatewayInteraction } from './interface';
import { editChannelMessage, editOriginal, sendChannelMessage } from './rest';
import { linkAccount } from './store';
import { getDiscordProfile } from '../api/client';
import { tokenIdFor } from '../core/config';
import { logger } from '../core/logger';

interface LiveSession {
	cancel: () => void;
	/** Token interaction của tin nhắn cũ, để sửa nó khi có link mới. */
	interactionToken: string;
}

/** Phiên đang mở của từng người, để link cũ không còn sống khi có link mới. */
const liveSessions = new Map<string, LiveSession>();

const BLURPLE = 0x5865f2;
const AMBER = 0xfaa61a;
const GREEN = 0x57f287;
const RED = 0xed4245;

export async function handleQrCommand(interaction: GatewayInteraction): Promise<void> {
	const userId = interaction.member?.user.id ?? interaction.user?.id ?? '';
	const { startQrLogin } = await import('../api/qrAuth');

	/** Nút mở link đăng nhập, có sau khi biết fingerprint. */
	let button: Record<string, unknown>[] = [];
	/** Người dùng đã xác nhận trên app chưa, để áp lại trạng thái nếu tới sớm. */
	let confirmed = false;
	/** Tin nhắn thông báo trong kênh, có mention để người dùng nhận thông báo. */
	let noticeId: string | null = null;
	const channelId = interaction.channel_id ?? '';

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

	const showScanned = async () => {
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: '🔐 Đang đăng nhập',
					description: `Đăng nhập với tư cách <@${userId}>\n-# Đã xác nhận, đang lấy token…`,
				},
			],
			components: button,
		});

		// Tin nhắn riêng trong kênh kèm mention: chỉ mention mới tạo thông báo,
		// còn tin nhắn tạm (ephemeral) thì sửa thế nào cũng im lặng.
		if (!channelId || noticeId) return;
		const sent = await sendChannelMessage(channelId, {
			content: `Đăng nhập với tư cách <@${userId}>`,
			allowed_mentions: { parse: ['users'] },
		});
		noticeId = sent?.id ?? null;
	};

	await waiting();

	// Mỗi người chỉ giữ một link sống. Link cũ mà bấm vào sẽ ra trang "không tìm thấy
	// thiết bị" của Discord, nên huỷ hẳn phiên trước.
	const previous = liveSessions.get(userId);
	if (previous) {
		previous.cancel();
		// Tin nhắn cũ vẫn còn nút; ghi đè để người dùng biết bấm vào là vô ích.
		await editOriginal(previous.interactionToken, {
			embeds: [{ color: AMBER, description: 'Link này đã được thay bằng lần `/login` mới hơn.' }],
		}).catch(() => undefined);
	}

	let session: Awaited<ReturnType<typeof startQrLogin>>;
	try {
		session = await startQrLogin({
			onScanned: (username) => {
				// Có thể tới trước cả lúc tin nhắn kịp hiện nút; giữ lại để áp sau.
				confirmed = true;
				void username;
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

	liveSessions.set(userId, { cancel: session.cancel, interactionToken: interaction.token });
	// Dọn khi phiên kết thúc để không giữ tham chiếu.
	const forget = () => {
		if (liveSessions.get(userId)?.cancel === session.cancel) liveSessions.delete(userId);
	};

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
	if (confirmed) await showScanned().catch(() => undefined);

	const closeNotice = async (content: string) => {
		if (!channelId || !noticeId) return;
		await editChannelMessage(channelId, noticeId, { content, allowed_mentions: { parse: [] } });
	};

	let failure: string | null = null;
	const token = await session.wait.catch((error: Error) => {
		logger.warn(`Đăng nhập thất bại: ${error.message}`);
		failure = error.message;
		return null;
	});
	forget();

	if (!token) {
		await closeNotice(`Đăng nhập với tư cách <@${userId}> không hoàn tất`);
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: 'Link không dùng được nữa',
					description: [
						(failure ?? 'Link đã hết hạn.').slice(0, 300),
						'Mỗi lần \`/login\` chỉ giữ một link sống; bấm vào link của tin nhắn cũ sẽ ra trang "không tìm thấy thiết bị".',
						'Chạy lại \`/login\` để lấy link mới.',
					].join('\n'),
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

	await closeNotice(`✅ Đã đăng nhập với tư cách <@${userId}>`);
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
