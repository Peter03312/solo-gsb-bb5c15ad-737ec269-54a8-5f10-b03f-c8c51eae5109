'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回/驳回缺原因、
 *       接续缺操作人/目标版本、目标版本不高于当前版本）
 *   404 资源不存在
 *   409 冲突（提示已有结果、版本已发布不可改、撤回时当前状态不允许或下游仍已触发、
 *       复核申请重复/已处置/处置人身份不符、待复核期间跳过或撤回、
 *       演出已转只读后的现场操作与再次接续、接续核对冲突——附 conflicts 编号与原因）
 *   422 校验未通过（缺失引用/循环依赖）或前置未触发（受阻，含复核确认时前置失效）
 */
const { db, withTx } = require('./db');
const { validateCues, CUE_TYPES } = require('./validate');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

/* ---------------- 工具 ---------------- */

const ACTION_TEXT = { fired: '已触发', skipped: '已跳过', retracted: '已撤回' };
const REQUEST_STATUS_TEXT = { pending: '待复核', confirmed: '已确认', cancelled: '已撤销', rejected: '已驳回' };
const TYPE_TEXT = { light: '灯光', sound: '音效', set: '布景', other: '其他' };

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
    needs_review: raw && raw.needs_review ? 1 : 0,
  };
}

function getShow(id) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) throw new HttpError(404, '场次不存在');
  return show;
}

function getVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) throw new HttpError(404, '版本不存在');
  return v;
}

function getVersionCues(versionId) {
  return db
    .prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq')
    .all(versionId)
    .map((c) => ({ ...c, deps: JSON.parse(c.deps) }));
}

function conflictError(existing) {
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action]}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 演出内各提示的最新一条事件（cue_id -> event）。
 * 当前有效结果规则：最新事件为 fired/skipped 即有效；retracted（已撤回）或无事件 = 无有效结果。
 * 所有写操作在 BEGIN IMMEDIATE 事务内"读最新→判定→写入"，保证至多一个当前有效结果。
 */
function latestEventsByCue(performanceId) {
  const rows = db.prepare('SELECT * FROM cue_events WHERE performance_id = ? ORDER BY id').all(performanceId);
  const map = new Map();
  for (const e of rows) map.set(e.cue_id, e);
  return map;
}

function effectiveAction(latest) {
  return latest && latest.action !== 'retracted' ? latest.action : null;
}

/**
 * 只读演出（已接续到修订执行单）拒绝一切现场写操作与再次接续。
 * 须在事务内调用，与现场操作串行判定。
 */
function assertPerfWritable(perf) {
  if (perf.status === 'readonly') {
    const cont = db.prepare('SELECT * FROM performance_continuations WHERE from_performance_id = ?').get(perf.id);
    throw new HttpError(
      409,
      `该演出已改用修订执行单并转为只读${cont ? `（接续至演出 #${cont.to_performance_id}）` : ''}，现场操作请在接续演出中进行`,
      { continued_to: cont ? cont.to_performance_id : null }
    );
  }
}

/** 演出与提示的存在性校验（提示须属于演出锁定的版本），供各写操作复用；只读演出在此统一拒绝 */
function getPerfCue(performanceId, cueId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertPerfWritable(perf);
  const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
  if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');
  return { perf, cue };
}

/** 该演出某提示当前待复核的申请（无则 null）。须在事务内调用以保证判定一致 */
function pendingRequestFor(performanceId, cueId) {
  return db.prepare(
    "SELECT * FROM cue_review_requests WHERE performance_id = ? AND cue_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  ).get(performanceId, cueId) || null;
}

/** 当前有效结果为"已触发"的提示编号集合（已撤回的不算） */
function firedLabelSet(versionId, latestByCue) {
  const rows = db.prepare('SELECT id, label FROM cues WHERE version_id = ?').all(versionId);
  return new Set(
    rows.filter((r) => {
      const e = latestByCue.get(r.id);
      return e && e.action === 'fired';
    }).map((r) => r.label)
  );
}

/* ---------------- 路由表 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
}

/* ---- 场次 ---- */

route('GET', '/api/shows', () => {
  const shows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id) AS version_count,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id AND v.status = 'published') AS published_count,
      (SELECT COUNT(*) FROM performances p WHERE p.show_id = s.id) AS performance_count
    FROM shows s ORDER BY s.id DESC
  `).all();
  return { shows };
});

route('POST', '/api/shows', (body) => {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, '场次名称不能为空');
  const info = db.prepare('INSERT INTO shows (name) VALUES (?)').run(name);
  return { show: db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/shows/:id', (body, p) => {
  const show = getShow(p.id);
  const versions = db.prepare(
    'SELECT id, show_id, version_number, status, note, created_at, published_at FROM versions WHERE show_id = ? ORDER BY version_number DESC'
  ).all(show.id);
  const performances = db.prepare(`
    SELECT p.*, v.version_number,
      (SELECT c.from_performance_id FROM performance_continuations c WHERE c.to_performance_id = p.id) AS continued_from,
      (SELECT c.to_performance_id FROM performance_continuations c WHERE c.from_performance_id = p.id) AS continued_to
    FROM performances p
    JOIN versions v ON v.id = p.version_id
    WHERE p.show_id = ? ORDER BY p.id DESC
  `).all(show.id);
  return { show, versions, performances };
});

/* ---- 版本（执行单） ---- */

route('POST', '/api/shows/:id/versions', (body, p) => {
  const show = getShow(p.id);
  return withTx(() => {
    // 基准版本：指定 from_version_id，否则取最新版本；没有则建空白草稿
    let base = null;
    if (body.from_version_id != null) {
      base = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
        .get(body.from_version_id, show.id);
      if (!base) throw new HttpError(404, '基准版本不存在');
    } else {
      base = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_number DESC LIMIT 1')
        .get(show.id);
    }
    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM versions WHERE show_id = ?')
      .get(show.id).m) + 1;
    const info = db.prepare('INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)')
      .run(show.id, nextNo, 'draft', String(body.note || '').slice(0, 200));
    const newId = Number(info.lastInsertRowid);
    if (base) {
      const cues = db.prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq').all(base.id);
      const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps, c.needs_review);
    }
    return { version: getVersion(newId), cues: getVersionCues(newId) };
  });
});

route('GET', '/api/versions/:id', (body, p) => {
  const version = getVersion(p.id);
  return { version, cues: getVersionCues(version.id) };
});

route('PUT', '/api/versions/:id/cues', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') {
    throw new HttpError(409, '该版本已发布，内容不可修改；请新建草稿版本');
  }
  if (!Array.isArray(body.cues)) throw new HttpError(400, '请求格式错误：cues 应为数组');
  if (body.cues.length > 500) throw new HttpError(400, '提示数量过多（上限 500）');

  const cues = body.cues.map(sanitizeCue);
  withTx(() => {
    db.prepare('DELETE FROM cues WHERE version_id = ?').run(version.id);
    const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps, needs_review) VALUES (?,?,?,?,?,?,?)');
    cues.forEach((c, i) => ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps), c.needs_review));
  });
  // 草稿允许暂存不完整内容，同时返回校验结果供界面提示
  return { ok: true, errors: validateCues(cues), cues: getVersionCues(version.id) };
});

route('POST', '/api/versions/:id/validate', (body, p) => {
  getVersion(p.id);
  const cues = Array.isArray(body.cues) ? body.cues.map(sanitizeCue) : getVersionCues(p.id);
  return { errors: validateCues(cues) };
});

route('POST', '/api/versions/:id/publish', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') throw new HttpError(409, '该版本已发布');
  const cues = getVersionCues(version.id);
  const errors = validateCues(cues);
  if (errors.length) {
    throw new HttpError(422, '校验未通过，无法发布', { errors });
  }
  withTx(() => {
    db.prepare("UPDATE versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(version.id);
  });
  return { version: getVersion(version.id) };
});

/* ---- 演出 ---- */

route('POST', '/api/shows/:id/performances', (body, p) => {
  const show = getShow(p.id);
  let version;
  if (body.version_id != null) {
    version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(body.version_id, show.id);
    if (!version) throw new HttpError(404, '版本不存在');
    if (version.status !== 'published') {
      throw new HttpError(400, `版本 v${version.version_number} 尚未发布，不能用于启动演出`);
    }
  } else {
    version = db.prepare(
      "SELECT * FROM versions WHERE show_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1"
    ).get(show.id);
    if (!version) throw new HttpError(400, '无已发布版本，请先发布执行单后再启动演出');
  }
  const name = String(body.name || '').trim().slice(0, 100);
  const operator = String(body.operator || '').trim().slice(0, 50);
  const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
    .run(show.id, version.id, name, operator);
  return { performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/performances/:id', (body, p) => {
  const perf = db.prepare(`
    SELECT p.*, s.name AS show_name, v.version_number
    FROM performances p
    JOIN shows s ON s.id = p.show_id
    JOIN versions v ON v.id = p.version_id
    WHERE p.id = ?
  `).get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');

  const cues = getVersionCues(perf.version_id);
  // 完整流水（含撤回与承接记录），按时间升序；返回时倒序（最新在上）。
  // source_event_id 非空 = 承接记录，source_performance_id 标出来源演出
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq, se.performance_id AS source_performance_id
    FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    LEFT JOIN cue_events se ON se.id = e.source_event_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(perf.id);

  // 归约当前有效结果：fired/skipped 生效，retracted 清除该提示的有效结果
  const eventByCue = new Map();
  for (const e of events) {
    if (e.action === 'retracted') eventByCue.delete(e.cue_id);
    else eventByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of eventByCue.values()) {
    if (e.action === 'fired') firedLabels.add(e.label);
  }

  const cueStates = cues.map((c) => {
    const event = eventByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / skipped
    } else {
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event };
  });

  // 双人复核申请流水（最新在上）；待复核申请同时挂到对应提示上，便于执行台禁用操作
  const reviewRequests = db.prepare(`
    SELECT r.*, c.label, c.seq FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.performance_id = ? ORDER BY r.id DESC
  `).all(perf.id);
  const pendingByCue = new Map();
  for (const r of reviewRequests) {
    if (r.status === 'pending' && !pendingByCue.has(r.cue_id)) pendingByCue.set(r.cue_id, r);
  }
  for (const c of cueStates) c.pending_request = pendingByCue.get(c.id) || null;

  // 接续关系：from = 本场承接自哪场演出；to = 本场已接续至哪场（转只读后存在）
  const contFrom = db.prepare(`
    SELECT c.id, c.from_performance_id, c.operator, c.carried_count, c.created_at,
           v.version_number AS from_version_number
    FROM performance_continuations c
    JOIN performances p ON p.id = c.from_performance_id
    JOIN versions v ON v.id = p.version_id
    WHERE c.to_performance_id = ?
  `).get(perf.id) || null;
  const contTo = db.prepare(`
    SELECT c.id, c.to_performance_id, c.operator, c.carried_count, c.created_at,
           v.version_number AS to_version_number
    FROM performance_continuations c
    JOIN performances p ON p.id = c.to_performance_id
    JOIN versions v ON v.id = p.version_id
    WHERE c.from_performance_id = ?
  `).get(perf.id) || null;

  return {
    performance: perf,
    cues: cueStates,
    events: events.slice().reverse(),
    review_requests: reviewRequests,
    continuation: { from: contFrom, to: contTo },
  };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 事务内读最新事件再判定写入） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 待复核申请处理前，该提示禁止跳过（fire 对需复核提示已在路由层转为登记申请，不会走到这里）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能${action === 'skipped' ? '跳过' : '触发'}`,
        { request: pending }
      );
    }

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      if (deps.length) {
        // 前置是否满足以"当前有效结果为已触发"判定（已撤回的前置不算）
        const fired = firedLabelSet(perf.version_id, latestByCue);
        const unmet = deps.filter((d) => !fired.has(d));
        if (unmet.length) {
          throw new HttpError(422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
        }
      }
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, action, operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/**
 * 撤回误触发：仅当前有效结果为"已触发"可撤回；已跳过 / 未触发（含已撤回）拒绝。
 * 若沿前置关系可达的后续提示仍有有效"已触发"，整体拒绝并列出受影响编号，任何记录都不改变。
 * 成功后写入 retracted 流水（原触发记录保留），提示回到 待执行 / 受阻，可再次触发或跳过。
 */
function retractEvent(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const { perf, cue } = getPerfCue(performanceId, cueId);

    // 待复核申请处理前禁止撤回（此时提示本就无有效结果，这里给出更明确的错误）
    const pending = pendingRequestFor(performanceId, cueId);
    if (pending) {
      throw new HttpError(
        409,
        `该提示存在待复核的触发申请（申请人 ${pending.requested_by}，时间 ${pending.requested_at}），复核处置前不能撤回`,
        { request: pending }
      );
    }

    const latestByCue = latestEventsByCue(performanceId);
    const latest = latestByCue.get(cueId) || null;
    const current = effectiveAction(latest);
    if (current === 'skipped') {
      throw new HttpError(
        409,
        `该提示当前结果为已跳过，不能撤回（操作人 ${latest.operator}，时间 ${latest.created_at}）`,
        { current: latest }
      );
    }
    if (current !== 'fired') {
      throw new HttpError(409, '该提示当前未处于已触发状态，不能撤回', { current: latest });
    }

    // 反向 BFS：沿前置关系找出所有下游提示，其中仍有效"已触发"的即为受影响项
    const cues = getVersionCues(perf.version_id);
    const childrenOf = new Map();
    for (const c of cues) {
      for (const dep of c.deps) {
        if (!childrenOf.has(dep)) childrenOf.set(dep, []);
        childrenOf.get(dep).push(c);
      }
    }
    const affected = [];
    const visited = new Set([cue.label]);
    const queue = [cue.label];
    while (queue.length) {
      const curLabel = queue.shift();
      for (const child of childrenOf.get(curLabel) || []) {
        if (visited.has(child.label)) continue;
        visited.add(child.label);
        queue.push(child.label);
        const e = latestByCue.get(child.id);
        if (e && e.action === 'fired') affected.push(child.label);
      }
    }
    if (affected.length) {
      throw new HttpError(
        409,
        `无法撤回：以下后续提示仍处于已触发状态，请先撤回：${affected.join('、')}`,
        { affected }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, 'retracted', operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/* ---- 双人复核：触发申请 / 确认 / 撤销 / 驳回 ---- */

/**
 * 登记触发申请：仅登记申请人与时间，提示不算已触发、下游前置仍受阻。
 * 重复申请（已有待复核）或提示已有结果时 409。前置是否满足在确认时才判定，申请阶段不限制。
 */
function createReviewRequest(performanceId, cueId, operator) {
  return withTx(() => {
    const { cue } = getPerfCue(performanceId, cueId);

    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(cueId) || null;
    if (effectiveAction(current)) throw conflictError(current);

    const existing = pendingRequestFor(performanceId, cueId);
    if (existing) {
      throw new HttpError(
        409,
        `该提示已存在待复核的触发申请（申请人 ${existing.requested_by}，时间 ${existing.requested_at}），请勿重复申请`,
        { request: existing }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_review_requests (performance_id, cue_id, requested_by) VALUES (?,?,?)'
    ).run(performanceId, cueId, operator);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/** 取申请并校验属于该演出；只读演出在此统一拒绝（撤销/驳回不经过 getPerfCue） */
function getReviewRequest(performanceId, requestId) {
  const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
  if (!perf) throw new HttpError(404, '演出不存在');
  assertPerfWritable(perf);
  const req = db.prepare(
    'SELECT * FROM cue_review_requests WHERE id = ? AND performance_id = ?'
  ).get(requestId, performanceId);
  if (!req) throw new HttpError(404, '复核申请不存在');
  return req;
}

function requestConflict(req) {
  return new HttpError(
    409,
    `该申请已处置：${REQUEST_STATUS_TEXT[req.status]}（处置人 ${req.resolved_by || '-'}，时间 ${req.resolved_at || '-'}）`,
    { request: req }
  );
}

/**
 * 确认申请：须为申请人之外的另一操作人；且前置当前均已触发，否则 422 且申请保持待复核。
 * 确认与撤销/驳回在同一事务内判定，并发只有一种结局。确认后写入有效 fired 流水并关联申请。
 */
function confirmReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '复核确认人不能与申请人相同，须由另一操作人确认', { request: req });
    }

    const { perf, cue } = getPerfCue(performanceId, req.cue_id);
    const latestByCue = latestEventsByCue(performanceId);
    const current = latestByCue.get(req.cue_id) || null;
    if (effectiveAction(current)) throw conflictError(current);

    // 前置失效（未触发或已撤回）时拒绝确认，申请保持待复核
    const deps = JSON.parse(cue.deps);
    if (deps.length) {
      const fired = firedLabelSet(perf.version_id, latestByCue);
      const unmet = deps.filter((d) => !fired.has(d));
      if (unmet.length) {
        throw new HttpError(422, `前置提示未触发，无法确认：${unmet.join('、')}`, { unmet, request: req });
      }
    }

    const evInfo = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, req.cue_id, 'fired', operator, `双人复核确认（申请人：${req.requested_by}）`);
    const eventId = Number(evInfo.lastInsertRowid);
    db.prepare(
      "UPDATE cue_review_requests SET status = 'confirmed', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), event_id = ? WHERE id = ?"
    ).run(operator, eventId, req.id);
    return {
      request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id),
      event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(eventId),
    };
  });
}

/** 撤销申请：仅申请人本人可撤销待复核申请 */
function cancelReviewRequest(performanceId, requestId, operator) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by !== operator) {
      throw new HttpError(409, `只能由申请人本人（${req.requested_by}）撤销该申请`, { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'cancelled', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(operator, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

/** 驳回申请：申请人之外的其他人填写原因驳回 */
function rejectReviewRequest(performanceId, requestId, operator, reason) {
  return withTx(() => {
    const req = getReviewRequest(performanceId, requestId);
    if (req.status !== 'pending') throw requestConflict(req);
    if (req.requested_by === operator) {
      throw new HttpError(409, '申请人请使用撤销；驳回须由其他操作人执行', { request: req });
    }
    db.prepare(
      "UPDATE cue_review_requests SET status = 'rejected', resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), resolve_reason = ? WHERE id = ?"
    ).run(operator, reason, req.id);
    return { request: db.prepare('SELECT * FROM cue_review_requests WHERE id = ?').get(req.id) };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  // 需双人复核的提示：触发接口转为登记复核申请，不能绕过复核直接写入触发流水；
  // 普通提示保持原有行为与响应（{ event }）
  const { cue } = getPerfCue(perfId, cueId);
  if (cue.needs_review) return createReviewRequest(perfId, cueId, operator);
  return recordEvent(perfId, cueId, 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/review-requests', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const perfId = Number(p.id);
  const cueId = Number(p.cueId);
  const { cue } = getPerfCue(perfId, cueId);
  if (!cue.needs_review) {
    throw new HttpError(400, `提示「${cue.label}」未标记需双人复核，可直接触发`);
  }
  return createReviewRequest(perfId, cueId, operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/confirm', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return confirmReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/cancel', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return cancelReviewRequest(Number(p.id), Number(p.reqId), operator);
});

route('POST', '/api/performances/:id/review-requests/:reqId/reject', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '驳回必须填写原因');
  return rejectReviewRequest(Number(p.id), Number(p.reqId), operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/skip', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '跳过必须填写原因');
  return recordEvent(Number(p.id), Number(p.cueId), 'skipped', operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/retract', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '撤回必须填写原因');
  return retractEvent(Number(p.id), Number(p.cueId), operator, reason);
});

/* ---- 现场接续：改用修订执行单 ---- */

/** 接续链：从最早来源到当前演出（含当前，按时间先后），沿 performance_continuations 向上追溯 */
function continuationChain(performanceId) {
  const chain = [];
  const seen = new Set();
  let curId = performanceId;
  while (curId != null && !seen.has(curId)) {
    seen.add(curId);
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(curId);
    if (!perf) break;
    chain.unshift(perf);
    const cont = db.prepare('SELECT from_performance_id FROM performance_continuations WHERE to_performance_id = ?').get(curId);
    curId = cont ? cont.from_performance_id : null;
  }
  return chain;
}

/**
 * 接续链上各提示（按编号对齐）的当前有效结果：链内演出按时间先后归约，
 * fired/skipped 为有效结果，retracted 清除；承接记录与现场记录同样参与。
 * 返回 Map: label -> { action, event }
 */
function chainEffectiveResults(chain) {
  const byLabel = new Map();
  const q = db.prepare(`
    SELECT e.*, c.label FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `);
  for (const perf of chain) {
    for (const e of q.all(perf.id)) {
      if (e.action === 'retracted') byLabel.delete(e.label);
      else byLabel.set(e.label, { action: e.action, event: e });
    }
  }
  return byLabel;
}

/** 前置编号集合比较（顺序无关） */
function sameDepSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/**
 * 接续前核对（须在事务内调用，与现场操作串行判定）：
 * 1) 链上各演出不得有待复核的触发申请；
 * 2) 链上有任意触发/跳过/撤回流水、复核申请或承接结果的提示（按编号），
 *    新版执行单须保留其编号、类型、描述、前置编号集合与复核标记。
 * 返回冲突数组 [{ label, reason }]，空数组表示可接续。
 */
function continuationConflicts(chain, newCues) {
  const conflicts = [];
  const seen = new Set();
  const push = (label, reason) => {
    const key = `${label}${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({ label, reason });
  };
  const ids = chain.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');

  // 待复核申请：接续前必须处置完毕
  const pendings = db.prepare(`
    SELECT c.label, r.requested_by FROM cue_review_requests r
    JOIN cues c ON c.id = r.cue_id
    WHERE r.status = 'pending' AND r.performance_id IN (${ph})
    ORDER BY r.id
  `).all(...ids);
  for (const r of pendings) {
    push(r.label, `存在待复核的触发申请（申请人 ${r.requested_by}），须先确认、撤销或驳回`);
  }

  // 有执行痕迹的提示：其在新版中的定义须与原样保留
  const touched = db.prepare(`
    SELECT * FROM cues WHERE id IN (
      SELECT cue_id FROM cue_events WHERE performance_id IN (${ph})
      UNION
      SELECT cue_id FROM cue_review_requests WHERE performance_id IN (${ph})
    )
  `).all(...ids, ...ids);

  const newByLabel = new Map(newCues.map((c) => [c.label, c]));
  for (const t of touched) {
    const nc = newByLabel.get(t.label);
    if (!nc) {
      push(t.label, '新版执行单缺少该编号，无法承接其执行痕迹');
      continue;
    }
    if (nc.type !== t.type) {
      push(t.label, `类型不一致（当前「${TYPE_TEXT[t.type] || t.type}」，新版「${TYPE_TEXT[nc.type] || nc.type}」）`);
    }
    if (nc.description !== t.description) {
      push(t.label, '描述不一致（新版改动了该提示的描述）');
    }
    const oldDeps = JSON.parse(t.deps);
    if (!sameDepSet(oldDeps, nc.deps)) {
      push(t.label, `前置编号集合不一致（当前 ${oldDeps.join('、') || '无'}，新版 ${nc.deps.join('、') || '无'}）`);
    }
    if (Number(nc.needs_review) !== Number(t.needs_review)) {
      push(t.label, `复核标记不一致（当前${t.needs_review ? '需' : '无需'}双人复核，新版${nc.needs_review ? '需' : '无需'}）`);
    }
  }
  return conflicts;
}

/**
 * 生成接续演出：原演出转只读（仍绑定原快照），新演出使用目标版本并继承链上有效结果。
 * 承接结果写入带 source_event_id 的记录（标出来源事件，不伪造再次触发）；
 * 未执行提示不做任何记录，其状态按新版依赖计算。全部判定与写入在同一事务内完成，
 * 与现场操作串行；核对冲突时整体回滚，原演出保持可操作且不产生接续记录。
 */
function continuePerformance(performanceId, body) {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  if (body.version_id == null) throw new HttpError(400, '请指定目标版本 version_id');

  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');
    // 已转只读的演出不能再次接续：多次接续只允许从当前可操作演出发起
    assertPerfWritable(perf);

    const curVersion = getVersion(perf.version_id);
    const version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
      .get(body.version_id, perf.show_id);
    if (!version) throw new HttpError(404, '目标版本不存在或不属于本场次');
    if (version.status !== 'published') {
      throw new HttpError(400, `目标版本 v${version.version_number} 尚未发布，不能用于接续`);
    }
    if (version.version_number <= curVersion.version_number) {
      throw new HttpError(400, `目标版本须高于当前版本（当前 v${curVersion.version_number}，目标 v${version.version_number}）`);
    }

    const chain = continuationChain(perf.id);
    const newCues = getVersionCues(version.id);
    const conflicts = continuationConflicts(chain, newCues);
    if (conflicts.length) {
      const summary = conflicts.slice(0, 5).map((c) => `${c.label}：${c.reason}`).join('；');
      throw new HttpError(
        409,
        `无法接续到 v${version.version_number}，共 ${conflicts.length} 处冲突：${summary}${conflicts.length > 5 ? '；…' : ''}`,
        { conflicts }
      );
    }

    // 新演出绑定目标版本快照；名称缺省沿用原演出
    const name = String(body.name || '').trim().slice(0, 100) || perf.name;
    const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
      .run(perf.show_id, version.id, name, operator);
    const newPerfId = Number(info.lastInsertRowid);

    // 原演出转为只读（version_id 不变，仍绑定原快照，流水照常可查）
    db.prepare("UPDATE performances SET status = 'readonly' WHERE id = ?").run(perf.id);

    // 继承链上各提示的当前有效结果：按编号对齐到新版提示，写入承接记录并标出来源事件
    const effective = chainEffectiveResults(chain);
    const newCueByLabel = new Map(newCues.map((c) => [c.label, c]));
    const insEvent = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason, source_event_id) VALUES (?,?,?,?,?,?)'
    );
    const carried = [];
    for (const [label, r] of effective) {
      const target = newCueByLabel.get(label);
      if (!target) continue; // 核对已保证编号存在，防御性跳过
      const src = r.event;
      const reason = `承接自演出 #${src.performance_id} 的${ACTION_TEXT[r.action]}结果（原操作人 ${src.operator}，时间 ${src.created_at}）`;
      const evInfo = insEvent.run(newPerfId, target.id, r.action, operator, reason, src.id);
      carried.push({ label, action: r.action, source_event_id: src.id, event_id: Number(evInfo.lastInsertRowid) });
    }

    const contInfo = db.prepare(
      'INSERT INTO performance_continuations (from_performance_id, to_performance_id, operator, carried_count) VALUES (?,?,?,?)'
    ).run(perf.id, newPerfId, operator, carried.length);

    return {
      performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(newPerfId),
      continuation: db.prepare('SELECT * FROM performance_continuations WHERE id = ?').get(Number(contInfo.lastInsertRowid)),
      carried,
    };
  });
}

route('POST', '/api/performances/:id/continue', (body, p) => continuePerformance(Number(p.id), body));

/* ---------------- 分发 ---------------- */

async function handle(req, res, url, body) {
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = await r.handler(body, params, req);
    return { status: 200, data: result };
  }
  throw new HttpError(404, '接口不存在');
}

module.exports = { handle, HttpError };
