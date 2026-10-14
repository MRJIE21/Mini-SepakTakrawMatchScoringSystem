/* 带时区的记录时间转换为本地时间，无时区的计划时间保留原口径。 */
export function fmtDateTime(value) {
  if (!value) return '';
  const text = String(value);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text.replace('T', ' ').slice(0, 16);
  const stamp = new Date(text);
  if (Number.isNaN(stamp.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
}

export function compareScheduledMatches(a, b) {
  const at = String(a.scheduled_at || '').trim().replace('T', ' ');
  const bt = String(b.scheduled_at || '').trim().replace('T', ' ');
  return Number(!at) - Number(!bt) || at.localeCompare(bt)
    || (a.stage_id || 0) - (b.stage_id || 0) || (a.round_no || 0) - (b.round_no || 0)
    || (a.seq || 0) - (b.seq || 0) || (a.id || 0) - (b.id || 0);
}
