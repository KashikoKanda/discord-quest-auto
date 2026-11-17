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
import { openManualTicket, solveAutomatically, solverService, type CaptchaChallenge } from '../api/captcha';

interface LiveSession {
	cancel: () => void;
	/** Token interaction của tin nhắn cũ, để sửa nó khi có link mới. */
	interactionToken: string;
	/** Link đang sống, để lần gọi lại dùng đúng link cũ thay vì huỷ phiên. */
	link: string;
	createdAt: number;
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

	// Mỗi người chỉ giữ một link sống.
	const previous = liveSessions.get(userId);
	if (previous && Date.now() - previous.createdAt < 100_000) {
		// Vừa mới xin link xong mà gọi lại thì trả đúng link đó: huỷ phiên rồi tạo
		// phiên mới chỉ làm người dùng mất phiên ngay sau khi vừa mở.
		await editOriginal(interaction.token, {
			content: '',
			components: [
				{
					type: 1,
					components: [
						{
							type: 2,
							style: 5,
							label: 'Đăng nhập ngay',
							emoji: { name: '🔐' },
							url: previous.link,
						},
					],
				},
			],
		});
		return;
	}

	if (previous) {
		previous.cancel();
		// Tin nhắn cũ vẫn còn nút; ghi đè để người dùng biết bấm vào là vô ích.
		await editOriginal(previous.interactionToken, {
			embeds: [{ color: AMBER, description: 'Link này đã được thay bằng lần `/login` mới hơn.' }],
		}).catch(() => undefined);
	}

	/** Xử lý khi Discord đòi captcha: tự giải nếu có key, không thì đưa link cho người dùng. */
	const onCaptcha = async (challenge: CaptchaChallenge): Promise<string | null> => {
		if (solverService()) {
			await editOriginal(interaction.token, {
				embeds: [
					{
						color: AMBER,
						description: `Đang giải captcha bằng ${solverService()}…`,
					},
				],
			});
			try {
				return await solveAutomatically(challenge);
			} catch (error) {
				logger.warn(`Giải captcha tự động lỗi: ${(error as Error).message}`);
			}
		}

		const base = process.env.RENDER_EXTERNAL_URL?.trim();
		if (!base) return null;

		const ticket = openManualTicket(challenge);
		const pageUrl = `${base.replace(/\/$/, '')}/captcha?id=${ticket.id}`;

		await editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: '🔐 Discord cần xác minh',
					description: `Bấm nút bên dưới, tick captcha là xong.\n-# Link sống 5 phút`,
				},
			],
			components: [
				{
					type: 1,
					components: [{ type: 2, style: 5, label: 'Giải captcha', emoji: { name: '🧩' }, url: pageUrl }],
				},
			],
		});

		try {
			return await ticket.wait;
		} catch (error) {
			logger.warn(`Chờ giải captcha thất bại: ${(error as Error).message}`);
			return null;
		}
	};

	let session: Awaited<ReturnType<typeof startQrLogin>>;
	try {
		session = await startQrLogin(
			{
				onScanned: (username) => {
					// Có thể tới trước cả lúc tin nhắn kịp hiện nút; giữ lại để áp sau.
					confirmed = true;
					void username;
					if (button.length > 0) showScanned().catch(() => undefined);
				},
			},
			{ onCaptcha },
		);
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

	liveSessions.set(userId, {
		cancel: session.cancel,
		interactionToken: interaction.token,
		link,
		createdAt: Date.now(),
	});
	// Dọn khi phiên kết thúc để không giữ tham chiếu.
	const forget = () => {
		if (liveSessions.get(userId)?.cancel === session.cancel) liveSessions.delete(userId);
	};

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
	let token = await session.wait.catch((error: Error) => {
		logger.warn(`Đăng nhập thất bại: ${error.message}`);
		failure = error.message;
		return null;
	});
	forget();

	// Phiên hay bị Discord/proxy cắt ngay sau khi mở; thử lại vài lần trước khi báo lỗi.
	for (let retry = 1; retry <= 2 && !token && /đóng|hết hạn|huỷ/i.test(failure ?? ''); retry += 1) {
		await editOriginal(interaction.token, {
			embeds: [{ color: AMBER, description: `Mất phiên, đang thử lại (${retry}/2)…` }],
		}).catch(() => undefined);

		try {
			const again = await startQrLogin({ onScanned: () => undefined }, { onCaptcha });
			liveSessions.set(userId, {
				cancel: again.cancel,
				interactionToken: interaction.token,
				link: `https://discord.com/ra/${again.fingerprint}`,
				createdAt: Date.now(),
			});
			button = [
				{
					type: 1,
					components: [
						{
							type: 2,
							style: 5,
							label: 'Đăng nhập ngay',
							emoji: { name: '🔐' },
							url: `https://discord.com/ra/${again.fingerprint}`,
						},
					],
				},
			];
			await editOriginal(interaction.token, { content: '', components: button }).catch(() => undefined);
			token = await again.wait.catch((error: Error) => {
				logger.warn(`Đăng nhập lại thất bại: ${error.message}`);
				failure = error.message;
				return null;
			});
			liveSessions.delete(userId);
		} catch (error) {
			failure = (error as Error).message;
			break;
		}
	}

	if (!token) {
		await closeNotice(`Đăng nhập với tư cách <@${userId}> không hoàn tất`);
		await editOriginal(interaction.token, {
			embeds: [
				{
					color: AMBER,
					title: /captcha/i.test(failure ?? '') ? 'Discord từ chối captcha' : 'Link không dùng được nữa',
					description: /captcha/i.test(failure ?? '')
						? [
								(failure ?? '').slice(0, 200),
								'',
								'Captcha giải trên trang của bot bị Discord coi là lạ nên nó đòi lại.',
								'Cách chắc ăn: `/link` dán token, hoặc đặt `CAPSOLVER_API_KEY` để bot tự giải đúng chuẩn enterprise.',
								'Proxy dân dụng (residential) cũng tránh được captcha, khác proxy datacenter hiện tại.',
							].join('\n')
						: [
								(failure ?? 'Link đã hết hạn.').slice(0, 300),
								'Mỗi lần `/login` chỉ giữ một link sống; bấm vào link của tin nhắn cũ sẽ ra trang "không tìm thấy thiết bị".',
								'Chạy lại `/login` để lấy link mới.',
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
