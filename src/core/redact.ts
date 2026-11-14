/**
 * Che token Discord trước khi ghi log.
 *
 * Token bot có dạng `<base64 id>.<6 ký tự>.<27 ký tự>`; nếu lọt vào log rồi bị đẩy
 * lên GitHub hay dán vào đâu đó thì Discord thu hồi ngay. Mọi chuỗi đi qua logger
 * đều được lọc ở đây trước.
 */
const PATTERNS: RegExp[] = [
	/mfa\.[\w-]{80,}/g,
	/[\w-]{20,}\.[\w-]{5,7}\.[\w-]{25,}/g,
	/(?:Bot|Bearer)\s+[\w-]{20,}/gi,
	/(?:TOKEN|SECRET|PASSWORD|KEY)\s*=\s*\S+/gi,
];

export function redact(input: string): string {
	let output = input;
	for (const pattern of PATTERNS) output = output.replace(pattern, '<đã che>');
	return output;
}

export function tokenFingerprint(token: string): string {
	let hash = 0;
	for (let index = 0; index < token.length; index += 1) {
		hash = (hash * 31 + token.charCodeAt(index)) | 0;
	}
	return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}
