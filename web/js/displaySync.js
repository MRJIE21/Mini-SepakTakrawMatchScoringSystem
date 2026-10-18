/* 把计分页的本机草稿异步同步给大屏；失败不阻塞计分。 */
import { api } from './api.js';
import { summarize } from './scoring.js';

let latest = null;
let inflight = false;
let timer = null;
let heartbeat = null;
let failures = 0;

function clearTimer() { clearTimeout(timer); timer = null; }

function ensureHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!latest || document.visibilityState === 'hidden') return;
    flush();
  }, 30_000);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

export function syncDisplaySnapshot(draft, match) {
  if (!draft || !match || match.status !== 'ready') { stopDisplaySync(); return; }
  const status = String(draft.status || '');
  if (['submitted'].includes(status)) { stopDisplaySync(); return; }
  if (!['recording', 'waiting', 'review', 'failed'].includes(status)) { return; }
  latest = { draft, match };
  ensureHeartbeat();
  clearTimer();
  timer = setTimeout(flush, 120);
}

export function stopDisplaySync() {
  latest = null;
  failures = 0;
  clearTimer();
  stopHeartbeat();
}

function snapshot(draft, match) {
  const summary = summarize(draft.events || [], draft.rules);
  const sets = (summary.sets || []).map((item) => ({
    set_no: item.set_no,
    home_points: item.home_points,
    away_points: item.away_points,
    winner_side: item.winner_side || '',
  }));
  return {
    match_id: Number(draft.match_id || match.id),
    event_seq: (draft.events || []).reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0),
    status: summary.matchOver ? 'finished' : 'live',
    current_set: summary.currentSet,
    home_points: summary.liveScore?.[0] ?? 0,
    away_points: summary.liveScore?.[1] ?? 0,
    home_sets: summary.winners?.home ?? 0,
    away_sets: summary.winners?.away ?? 0,
    sets,
    draft_uid: draft.uid || '',
    lineup_hash: `${draft.lineup?.home || ''}:${draft.lineup?.away || ''}`,
  };
}

async function flush() {
  clearTimer();
  if (!latest) return;
  if (inflight) { timer = setTimeout(flush, 150); return; }
  inflight = true;
  const current = latest;
  try {
    await api.post('/api/display/live', snapshot(current.draft, current.match));
    failures = 0;
    if (latest !== current) timer = setTimeout(flush, 120);
  } catch (error) {
    failures += 1;
    if (error?.code === 'stale_snapshot' || error?.code === 'not_ready') {
      latest = null;
    } else if (latest) {
      timer = setTimeout(flush, Math.min(5000, 500 * failures));
    }
  } finally {
    inflight = false;
  }
}

window.addEventListener('beforeunload', stopDisplaySync);
