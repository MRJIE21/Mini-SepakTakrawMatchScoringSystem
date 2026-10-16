/* 提交包构造：计分页与核对页共用同一份不可变提交包，保证重试内容完全一致。 */

export function buildMatchPayload(draft, summary) {
  if (draft.payload) return draft.payload;   // 已构造过则原样复用，重试不改变内容
  const sets = (summary ? summary.sets : draft.sets || [])
    .filter((s) => s.home_points || s.away_points || s.winner_side)
    .map((s) => ({ set_no: s.set_no, home_points: s.home_points,
      away_points: s.away_points, winner_side: s.winner_side || '' }));
  const payload = {
    event_identity: draft.event_identity,
    submission_uid: draft.uid,
    match_id: draft.match_id,
    device: draft.device,
    base_version: draft.base_version,
    plan_version: draft.plan_version,
    ...(draft.rules_hash ? { rules_hash: draft.rules_hash } : {}),
    home_participation: draft.lineup ? draft.lineup.home : null,
    away_participation: draft.lineup ? draft.lineup.away : null,
    result_status: draft.result_status,
    sets,
    events: draft.events || [],
    note: draft.note || '',
  };
  draft.payload = structuredClone(payload);
  return draft.payload;
}

export function buildIndividualPayload(draft) {
  if (draft.payload) return draft.payload;
  const payload = {
    event_identity: draft.event_identity,
    submission_uid: draft.uid,
    participation_id: draft.participation_id,
    device: draft.device,
    base_version: draft.base_version,
    result_status: draft.result_status,
    result_value: draft.result_value === '' ? null : draft.result_value,
    error_count: draft.error_count === '' ? null : draft.error_count,
    violation_count: draft.violation_count === '' ? null : draft.violation_count,
    result_text: draft.result_text || '',
    rank_no: draft.rank_no === '' || draft.rank_no == null ? null : Number(draft.rank_no),
    note: draft.note || '',
  };
  if (draft.reason) payload.reason = draft.reason;
  draft.payload = structuredClone(payload);
  return draft.payload;
}
