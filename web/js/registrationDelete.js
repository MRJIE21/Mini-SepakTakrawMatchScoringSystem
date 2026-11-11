export const REGISTRATION_DELETE_CAPABILITY = 'registration.delete';
export const REGISTRATION_DELETE_BATCH_LIMIT = 100;

export function canDeleteRegistration(capabilities) {
  return Array.isArray(capabilities)
    && capabilities.includes(REGISTRATION_DELETE_CAPABILITY);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}无效`);
  return number;
}

export function registrationDeletePayload(categoryId, records) {
  const category_id = positiveInteger(categoryId, '报名项目');
  if (!Array.isArray(records) || !records.length) throw new Error('请先选择报名记录');
  if (records.length > REGISTRATION_DELETE_BATCH_LIMIT) {
    throw new Error(`单次最多删除 ${REGISTRATION_DELETE_BATCH_LIMIT} 条报名记录`);
  }
  const ids = records.map((record) => positiveInteger(record?.id, '报名记录'));
  if (new Set(ids).size !== ids.length) throw new Error('待删除报名记录不能重复');
  const base_revs = Object.fromEntries(records.map((record) => [
    String(positiveInteger(record.id, '报名记录')),
    positiveInteger(record.rev, `报名记录 ${record.id} 修订号`),
  ]));
  const schools = new Set(records.map((record) => Number(record.school_id)).filter(Number.isSafeInteger));
  const school = schools.size === 1 ? [...schools][0] : null;
  if (records.length === 1) {
    return { category_id, ...(school > 0 ? { school_id: school } : {}),
      base_rev: base_revs[String(ids[0])] };
  }
  return { category_id, ...(school > 0 ? { school_id: school } : {}), ids, base_revs };
}

function recordLabel(record) {
  const school = record.school_name || record.school_short || '学校待核对';
  if (record.athlete_id) return `${school} · ${record.subject || '运动员待核对'}`;
  return record.display || record.school_short || school;
}

export function registrationDeleteConfirmation(category, records) {
  const label = category?.name || '当前项目';
  const shown = records.slice(0, 8).map((record, index) =>
    `${index + 1}. ${recordLabel(record)}（记录 ID ${record.id}）`);
  if (records.length > shown.length) shown.push(`…另有 ${records.length - shown.length} 条`);
  return `待删除 ${records.length} 条报名记录\n项目：${label}\n${shown.join('\n')}\n\n`
    + '仅软删除报名记录；学校、用户账号和人员档案不会被删除。确认后才会提交。';
}

export function registrationDeleteSuccess(result) {
  const success = Number(result?.success_count || 0);
  const failure = Number(result?.failure_count || 0);
  return success === 1 && failure === 0
    ? '删除成功'
    : `删除成功：成功 ${success} 条，失败 ${failure} 条`;
}

export function registrationDeleteFailure(error, requestedCount) {
  const detail = error?.detail && typeof error.detail === 'object' ? error.detail : {};
  const success = Number(detail.success_count || 0);
  const failure = Number.isFinite(Number(detail.failure_count))
    ? Number(detail.failure_count) : Number(requestedCount || 0);
  const items = Array.isArray(detail.items) ? detail.items : [];
  const reasons = items.filter((item) => item && item.ok !== true).slice(0, 12)
    .map((item) => `记录 ${item.id ?? '—'}：${item.message || item.code || '删除失败'}`);
  const heading = `删除失败：成功 ${success} 条，失败 ${failure} 条`;
  return [heading, ...reasons, reasons.length ? null : (error?.message || '服务器未返回失败原因')]
    .filter(Boolean).join('\n');
}
