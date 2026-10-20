/* Registration keys are identifiers, not credentials. Never reuse an ID for a new request. */
export function registrationId(source = globalThis.crypto) {
  if (typeof source?.randomUUID === 'function') return source.randomUUID();
  if (typeof source?.getRandomValues !== 'function') throw new Error('浏览器无法生成报名标识，请使用支持 Web Crypto 的浏览器；当前输入已保留。');
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
