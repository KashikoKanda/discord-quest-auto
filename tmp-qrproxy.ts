async function main() {
	const { startQrLogin } = await import('./src/api/qrAuth');
	const t0 = Date.now();
	const s = await startQrLogin({});
	console.log('IP:', s.ip, '|', s.ipNote, '| đi thẳng:', s.directIp, '|', Date.now() - t0, 'ms');
	console.log('fingerprint:', s.fingerprint.slice(0, 8) + '…');
	s.cancel();
	await s.wait.catch(() => undefined);
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e?.message ?? e); process.exit(1); });
