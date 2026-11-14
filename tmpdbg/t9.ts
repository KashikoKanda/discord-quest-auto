import { readFileSync } from 'node:fs';

async function main() {
	const store = JSON.parse(readFileSync('.quest-bot.json', 'utf8'));
	const tok = Object.values(store.users)[0] as any;
	const { fetchDiscordQuests } = await import('../src/api/client');
	const { quests } = await fetchDiscordQuests(tok.token, 'dbg');
	const now = Date.now();
	const rows = (quests as any[]).map((q) => ({
		name: q.config?.messages?.quest_name ?? q.id,
		preview: q.preview,
		targeted: Array.isArray(q.targeted_content) ? q.targeted_content.length : q.targeted_content,
		features: (q.config?.features ?? []).join(','),
		expired: q.config?.expires_at ? new Date(q.config.expires_at).getTime() < now : false,
		enrolled: Boolean(q.user_status?.enrolled_at),
		done: Boolean(q.user_status?.completed_at),
	}));
	const live = rows.filter((r) => !r.expired);
	console.log('tổng', rows.length, '| còn hạn', live.length);
	console.log('preview=true:', rows.filter((r) => r.preview).length, '| còn hạn & preview:', live.filter((r) => r.preview).length);
	console.log('có targeted_content:', rows.filter((r) => r.targeted && r.targeted !== 0).length, '| còn hạn:', live.filter((r) => r.targeted && r.targeted !== 0).length);
	console.log('mẫu còn hạn:', JSON.stringify(live.slice(0, 4), null, 1));
	const liveNotOpen = live.filter((r) => !r.done);
	console.log('còn hạn chưa xong:', liveNotOpen.length, '| trong đó đã enroll:', liveNotOpen.filter((r) => r.enrolled).length);
	console.log(JSON.stringify(liveNotOpen.slice(0, 3), null, 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e?.message ?? e); process.exit(1); });
