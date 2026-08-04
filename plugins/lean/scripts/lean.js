#!/usr/bin/env node
/**
 * lean — 세션 상태를 읽어 "지금 어떻게 일해야 싼가"를 알려주는 훅 스크립트.
 *
 * 설계 원칙
 *  - 아무것도 차단하지 않는다. 신호만 준다.
 *  - 할 말이 없으면 아무것도 출력하지 않는다 (출력 자체가 비용이므로).
 *  - 같은 신호를 매 턴 반복하지 않는다 (throttle).
 *  - 외부 의존성 0. Node 표준 라이브러리만.
 *
 * 사용법
 *   node lean.js session-start   < hook JSON (stdin)
 *   node lean.js prompt          < hook JSON (stdin)
 *   node lean.js report          [--transcript <path>] [--cwd <path>]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MODE = process.argv[2] || 'prompt';

/* ------------------------------------------------------------------ config */

const DEFAULTS = {
  enabled: true,
  // 컨텍스트 한도. "auto"면 관측값으로 판별한다 — 컨텍스트가 200k를 넘은 적이
  // 있으면 1M 창이 켜져 있다는 뜻이므로 1000000, 아니면 200000.
  // 환경마다 다를 때(개인은 200k, 회사는 1M) 설정을 나누지 않아도 된다.
  // 숫자를 직접 넣으면 그 값이 그대로 쓰인다.
  contextLimit: 'auto',
  // 컨텍스트 점유율 임계치
  ctxWarn: 0.55,
  ctxHigh: 0.75,
  // 점유율과 별개로, 이 크기를 넘으면 캐시 적중이어도 턴당 비용이 붙는다.
  // 1M 창에서는 55%(550k)까지 기다리면 이미 많이 쓴 뒤이므로 절대 기준이 필요하다.
  ctxCostFloor: 250000,
  // 캐시 적중률이 이 아래로 떨어지면 컨텍스트가 흔들리고 있다는 뜻.
  // 판정은 누적이 아니라 최근 cacheWindowTurns턴의 이동창으로 한다 —
  // 누적은 세션이 길수록 둔해져서, 지금 벌어지는 재생성을 놓친다.
  cacheHitFloor: 0.55,
  cacheWindowTurns: 8,
  // 턴당 평균 출력 토큰 (effort에 따라 자동 보정된다 — EFFORT_SCALE 참고)
  outputHeavy: 1600,
  // 턴당 평균 컨텍스트 증가량
  ctxGrowthHeavy: 14000,
  // 전체 대비 서브에이전트 토큰 비중
  sidechainShare: 0.3,
  // 같은 신호를 다시 띄우기까지 최소 턴 수
  minTurnsBetweenNudges: 3,
  // 세션 시작 시 작업 원칙 카드를 주입할지
  sessionCard: true,
  // Obsidian 볼트를 제2 저장소로 쓸지. 볼트가 없으면 자동으로 무시된다.
  obsidian: true,
  // 볼트 자동 탐지가 틀릴 때 경로를 직접 지정
  vaultPath: null,
};

function loadConfig() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'lean.config.json'),
    path.join(process.cwd(), '.claude', 'lean.config.json'),
  ];
  let cfg = Object.assign({}, DEFAULTS);
  for (const p of candidates) {
    try {
      Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) {
      /* 없으면 기본값 */
    }
  }
  return cfg;
}

/* -------------------------------------------------------------------- util */

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));

/** cwd -> Claude Code 프로젝트 디렉터리 슬러그 (예: C:\Users\A -> C--Users-A) */
function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** 디렉터리 안에서 가장 최근에 수정된 .jsonl. 없으면 null. */
function newestJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch (_) {
    return null;
  }
  let best = null;
  let bestMtime = -1;
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = full;
      }
    } catch (_) {
      /* skip */
    }
  }
  return best ? { file: best, mtime: bestMtime } : null;
}

/**
 * 훅 stdin 없이 호출됐을 때 트랜스크립트를 찾는다.
 *   1) cwd에 대응하는 프로젝트 디렉터리
 *   2) 없으면 전체 프로젝트에서 가장 최근 것
 *
 * 2)가 필요한 이유: 셸의 cwd가 세션 프로젝트와 다를 수 있다(플러그인 폴더나
 * 하위 디렉터리에서 실행하는 경우). 그때 조용히 실패하는 대신 최근 세션을 쓴다.
 * 대체가 일어났으면 info.fallback에 표시해 호출자가 알릴 수 있게 한다.
 */
function findLatestTranscript(cwd, info) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const own = newestJsonl(path.join(root, projectSlug(cwd)));
  if (own) return own.file;

  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch (_) {
    return null;
  }
  let best = null;
  for (const d of dirs) {
    const c = newestJsonl(path.join(root, d));
    if (c && (!best || c.mtime > best.mtime)) best = c;
  }
  if (best && info) info.fallback = true;
  return best ? best.file : null;
}

/** 트랜스크립트가 아주 클 때는 뒷부분만 읽는다. */
function readTranscriptLines(file, maxBytes = 12 * 1024 * 1024) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) {
    return { lines: fs.readFileSync(file, 'utf8').split('\n'), partial: false };
  }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(maxBytes);
  fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  text = text.slice(text.indexOf('\n') + 1); // 잘린 첫 줄 버림
  return { lines: text.split('\n'), partial: true };
}

/* ----------------------------------------------------------------- analyze */

/**
 * 트랜스크립트에서 사용량 지표를 뽑는다.
 * 한 턴이 여러 assistant 라인으로 쪼개져 기록되므로 requestId로 중복을 제거한다.
 */
function analyze(lines) {
  const main = new Map(); // requestId -> usage
  const side = new Map(); // 전경 서브에이전트: isSidechain 엔트리
  const bg = new Map(); // 백그라운드 서브에이전트: taskId -> {tokens, toolUses, ms}
  let effort = null;
  let model = null;
  let speed = null;
  let lastTs = 0;

  for (const line of lines) {
    if (!line) continue;
    const hasUsage = line.indexOf('"usage"') !== -1;
    const hasBg = line.indexOf('subagent_tokens') !== -1;
    if (!hasUsage && !hasBg) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }

    // 백그라운드 서브에이전트는 부모 트랜스크립트에 isSidechain 엔트리를 남기지
    // 않는다. 사용량은 작업 완료 알림 텍스트에만 있다.
    // 같은 알림이 queue-operation과 user로 두 번 기록되고, 이 대화 자체가
    // 같은 문자열을 인용할 수도 있으므로 반드시 task-id로 중복을 제거한다.
    if (hasBg) {
      let txt = '';
      try {
        const c = (o.message && o.message.content) || o.content || '';
        txt = typeof c === 'string' ? c : JSON.stringify(c);
      } catch (_) {
        txt = '';
      }
      const id = /<task-id>([^<]+)<\/task-id>/.exec(txt);
      const tok = /<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(txt);
      if (id && tok && !bg.has(id[1])) {
        const tu = /<tool_uses>(\d+)<\/tool_uses>/.exec(txt);
        const ms = /<duration_ms>(\d+)<\/duration_ms>/.exec(txt);
        bg.set(id[1], {
          tokens: Number(tok[1]),
          toolUses: tu ? Number(tu[1]) : 0,
          ms: ms ? Number(ms[1]) : 0,
        });
      }
    }

    if (!hasUsage) continue;
    if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) continue;
    const u = o.message.usage;
    if (typeof u.output_tokens !== 'number') continue;
    const key = o.requestId || o.uuid;
    if (!key) continue;
    if (o.effort) effort = o.effort;
    if (o.message.model) model = o.message.model;
    if (u.speed) speed = u.speed;
    if (!o.isSidechain && o.timestamp) {
      // 마지막 캐시 쓰기 시각 — 만료 카운트다운의 기준
      const t = Date.parse(o.timestamp);
      if (!isNaN(t) && t > lastTs) lastTs = t;
    }
    (o.isSidechain ? side : main).set(key, u);
  }

  const m = {
    turns: 0,
    ctx: 0,
    out: 0,
    cacheRead: 0,
    cacheCreate: 0,
    freshIn: 0,
    sideTokens: 0,
    sideTurns: side.size,
    ctxSeries: [],
    cacheSeries: [], // 턴별 [read, create] — 이동창 계산용
    ephemeral5m: 0,
    ephemeral1h: 0,
    effort: effort,
    model: model,
    speed: speed,
    lastTs: lastTs,
  };

  for (const u of main.values()) {
    const inTot =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    m.turns++;
    m.out += u.output_tokens || 0;
    m.cacheRead += u.cache_read_input_tokens || 0;
    m.cacheCreate += u.cache_creation_input_tokens || 0;
    m.cacheSeries.push([u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0]);
    m.freshIn += u.input_tokens || 0;
    m.ctx = inTot; // 마지막 값이 현재 컨텍스트 크기
    m.ctxSeries.push(inTot);
    const cc = u.cache_creation || {};
    m.ephemeral5m += cc.ephemeral_5m_input_tokens || 0;
    m.ephemeral1h += cc.ephemeral_1h_input_tokens || 0;
  }

  for (const u of side.values()) {
    m.sideTokens +=
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.output_tokens || 0);
  }

  // 백그라운드 서브에이전트를 합산한다. 이게 빠지면 위임 비중 신호가
  // 가장 흔한 사용 형태(백그라운드 실행)에서 0으로 보고된다.
  m.bgCalls = bg.size;
  m.bgTokens = 0;
  m.bgToolUses = 0;
  m.bgMs = 0;
  for (const b of bg.values()) {
    m.bgTokens += b.tokens;
    m.bgToolUses += b.toolUses;
    m.bgMs += b.ms;
  }
  m.sideTokens += m.bgTokens;
  m.sideTurns += m.bgCalls;

  m.cacheHit =
    m.cacheRead + m.cacheCreate > 0 ? m.cacheRead / (m.cacheRead + m.cacheCreate) : 1;
  m.avgOut = m.turns ? m.out / m.turns : 0;
  m.growth =
    m.ctxSeries.length >= 4
      ? (m.ctxSeries[m.ctxSeries.length - 1] - m.ctxSeries[0]) / (m.ctxSeries.length - 1)
      : 0;
  m.totalTokens = m.ctx + m.out + m.sideTokens;

  return m;
}

/* ----------------------------------------------------------------- signals */

/**
 * output_tokens에는 thinking이 포함된다. effort가 높으면 출력이 커지는 게 정상이므로
 * 임계치를 보정해서, 실제 "말이 길어진" 경우에만 신호가 뜨게 한다.
 */
const EFFORT_SCALE = { low: 0.7, medium: 1, high: 1.9, xhigh: 2.6, max: 3.2 };

/**
 * 최근 n턴의 캐시 적중률(이동창).
 *
 * 누적 적중률은 세션이 길어질수록 분모가 커져서, 지금 막 시작된 재생성을
 * 희석해 버린다. 판정은 이 창으로 하고 누적은 참고로만 보여준다.
 * 토큰 가중이라 큰 턴이 그만큼 반영된다. 표본이 없으면 null.
 */
function recentCacheHit(m, n) {
  const w = m.cacheSeries.slice(-Math.max(2, n || 8));
  let read = 0;
  let create = 0;
  for (const [r, c] of w) {
    read += r;
    create += c;
  }
  if (read + create <= 0) return null;
  return { hit: read / (read + create), turns: w.length };
}

/**
 * 지금 상황에서 실제로 행동을 바꿀 만한 것만 신호로 만든다.
 * 각 항목은 [key, 한 줄 조언].
 */
function signals(m, cfg) {
  const out = [];
  const ratio = m.ctx / cfg.contextLimit;
  const outputHeavy = cfg.outputHeavy * (EFFORT_SCALE[m.effort] || 1);

  if (ratio >= cfg.ctxHigh) {
    out.push([
      'ctx-high',
      `컨텍스트 ${pct(ratio)}. 파일 통독 금지 — Grep으로 위치만 잡고 offset/limit으로 필요한 줄만. 지금 작업을 끝낼 수 있는 단위로 좁혀라.`,
    ]);
  } else if (ratio >= cfg.ctxWarn) {
    out.push([
      'ctx-warn',
      `컨텍스트 ${pct(ratio)}. 새 자료는 요약해서 들이고, 이미 읽은 파일은 다시 읽지 마라.`,
    ]);
  }

  // 1M 창에서는 점유율이 낮아도 절대 크기가 곧 턴당 비용이다.
  if (m.ctx >= cfg.ctxCostFloor && ratio < cfg.ctxWarn) {
    out.push([
      'ctx-cost',
      `컨텍스트 ${k(m.ctx)}. 창은 여유롭지만 이 크기가 매 턴 다시 계산된다 — 새 파일을 통째로 들이지 말고 필요한 구간만.`,
    ]);
  }

  const rc = recentCacheHit(m, cfg.cacheWindowTurns);
  if (m.turns >= 4 && rc && rc.turns >= 4 && rc.hit < cfg.cacheHitFloor) {
    out.push([
      'cache-churn',
      `최근 ${rc.turns}턴 캐시 적중 ${pct(rc.hit)} (누적 ${pct(m.cacheHit)}). 앞쪽 컨텍스트가 계속 재생성되고 있다 — 이미 읽은 것을 다시 끌어오지 말고 뒤에 덧붙이는 방향으로 진행해라.`,
    ]);
  }

  if (m.turns >= 3 && m.avgOut > outputHeavy) {
    out.push([
      'verbose',
      `턴당 출력 ${Math.round(m.avgOut)}t. 결론부터 쓰고, 코드·로그 재인용과 요약 반복을 빼라.`,
    ]);
  }

  if (m.ctxSeries.length >= 4 && m.growth > cfg.ctxGrowthHeavy) {
    out.push([
      'growth',
      `턴당 컨텍스트 +${k(m.growth)}. 툴 출력이 크다 — head/limit·필드 선택으로 잘라서 받아라.`,
    ]);
  }

  if (
    m.sideTurns > 0 &&
    m.totalTokens > 0 &&
    m.sideTokens / m.totalTokens > cfg.sidechainShare
  ) {
    out.push([
      'subagent',
      `서브에이전트 비중 ${pct(m.sideTokens / m.totalTokens)}. 서브에이전트는 컨텍스트를 처음부터 다시 쌓는다 — 2~3콜로 끝날 일은 직접 해라.`,
    ]);
  }

  return out;
}

/* ---------------------------------------------------- context limit (auto) */

const STD_LIMIT = 200000;
const BIG_LIMIT = 1000000;

function limitFile() {
  const dir = path.join(os.homedir(), '.claude', 'lean-state');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return path.join(dir, 'context-limit.json');
}

/**
 * 컨텍스트 한도를 정한다.
 *
 * 설정에 숫자가 있으면 그대로. "auto"면:
 *   1) 이번 세션에서 200k를 넘긴 적이 있으면 → 1M 창이 켜져 있다는 확정적 증거
 *   2) 아니면 이전에 감지해 둔 값 (세션 초반엔 아직 작아서 판별이 안 되므로 기억한다)
 *   3) 둘 다 없으면 200k
 *
 * 1)이 성립하면 기억해 둔다. 환경이 바뀌면 lean-state/context-limit.json을 지우면 된다.
 */
function resolveContextLimit(cfg, m) {
  if (typeof cfg.contextLimit === 'number') return cfg.contextLimit;

  const peak = m && m.ctxSeries && m.ctxSeries.length ? Math.max(...m.ctxSeries) : 0;
  if (peak > STD_LIMIT) {
    try {
      fs.writeFileSync(
        limitFile(),
        JSON.stringify({ limit: BIG_LIMIT, detectedAt: new Date().toISOString(), peak }),
        'utf8'
      );
    } catch (_) {
      /* 기억에 실패해도 판별 자체는 유효하다 */
    }
    return BIG_LIMIT;
  }

  try {
    const saved = JSON.parse(fs.readFileSync(limitFile(), 'utf8'));
    if (typeof saved.limit === 'number') return saved.limit;
  } catch (_) {
    /* 기록 없음 */
  }
  return STD_LIMIT;
}

/* ------------------------------------------------------------------- state */

function stateFile(sessionId) {
  const dir = path.join(os.homedir(), '.claude', 'lean-state');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return path.join(dir, `${(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '')}.json`);
}

function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  } catch (_) {
    return { lastTurn: -99, lastKeys: '' };
  }
}

function saveState(sessionId, state) {
  try {
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ output */

function emit(eventName, text) {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: text,
      },
    })
  );
}

const CARD = [
  '[lean] 이 세션의 작업 방식 — 1인 IT팀처럼, 적은 토큰으로 빠르게.',
  '',
  '## 역할 게이트',
  '기획·PM·개발·데브옵스를 순서대로 통과한다. 단, 역할은 별도 에이전트가 아니라 체크포인트다.',
  '역할별로 서술하지 말고, 정해진 형식의 짧은 산출물만 낸다. 역할 전환 자체를 보고하지 않는다.',
  '- 기획: 진짜 요구와 완료 기준. 1~3줄.',
  '- PM: 순서와 중단 조건. 항목 3~6개. 여러 단계면 TaskCreate로 남긴다.',
  '- 개발: 최소 변경으로 구현.',
  '- 데브옵스: 실제로 실행한 검증 명령과 그 결과. 안 돌렸으면 안 돌렸다고 쓴다.',
  '',
  '작업 크기가 어느 역할까지 켤지 정한다 — 작은 일에 전 역할을 켜는 것이 가장 큰 낭비다.',
  '- XS(파일 1개, 툴콜 1~2회): 개발만. 기획·PM 생략.',
  '- S(툴콜 2~5회): PM 한 줄 + 개발 + 검증 한 줄.',
  '- M(파일 여러 개 / 불확실): 네 역할 전부, 각 산출물은 위 형식대로 짧게.',
  '- L(새 기능·마이그레이션·되돌리기 어려운 변경): 전부 + 착수 전 사용자 확인.',
  '',
  '## 위임 라우팅',
  '판단 기준은 하나: **그 일의 중간 산출물이 내 컨텍스트에 남아야 하는가.**',
  '남을 필요가 없으면 위임이 이득이다(에이전트가 다 읽고 나는 결론만 받는다). 남아야 하면 직접 한다.',
  '- scout — 파일 수십 개에서 위치만 찾을 때. 좌표 목록만 돌아온다. (기획/탐색 단계)',
  '- architect — 여러 파일에 걸친 변경의 순서·위험을 짤 때. 실행 가능한 계획만 돌아온다. (PM 단계)',
  '- ops — 빌드/테스트/린트를 돌릴 때. 로그 대신 실패 원인 몇 줄만 돌아온다. (데브옵스 단계)',
  '- Explore — scout로 안 되는 넓고 애매한 탐색. Plan — architect보다 큰 아키텍처 판단.',
  '- general-purpose — 위 어디에도 안 맞는 다단계 작업.',
  '위임하지 않는 경우: 툴콜 2~3회로 끝나는 일, 맥락을 길게 설명해야 넘길 수 있는 일(설명 비용 > 절약분),',
  '코드를 직접 고쳐야 하는 일(개발 단계는 항상 내가 한다 — 위임하면 편집 맥락을 잃는다).',
  '독립적인 위임은 한 응답에 묶어 병렬로 던진다. 순차로 돌리면 대기 시간이 그대로 누적된다.',
  '',
  '## 실행 원칙',
  '- 탐색: Glob으로 후보 좁히고 → Grep(files_with_matches)으로 위치 잡고 → 그 줄만 Read(offset/limit). 통독은 마지막 수단.',
  '- 독립적인 툴 호출은 한 응답에 묶어서 병렬로. 방금 고친 파일은 다시 읽지 않는다.',
  '- 부분 수정은 Write가 아니라 Edit. 셸 grep/cat/find/ls 대신 전용 툴(구조화 출력이 더 싸다).',
  '- 셸 출력이 클 것 같으면 미리 잘라라(head, --limit, 필드 선택).',
  '- 답변은 결론부터. 방금 한 일을 다시 요약하지 않는다. 확인 질문은 답에 따라 결과물이 달라질 때만.',
  '- 검증은 가장 좁은 대상으로(전체 스위트 대신 해당 테스트 1개).',
  '',
  '더 깊은 전술이 필요하면 lean 스킬을 열어라.',
].join('\n');

/* -------------------------------------------------------------------- main */

function main() {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  if (MODE === 'report') {
    const cwd = arg('--cwd') || process.cwd();
    const info = {};
    const file = arg('--transcript') || findLatestTranscript(cwd, info);
    if (!file || !fs.existsSync(file)) {
      console.log('lean: 트랜스크립트를 찾지 못했습니다.');
      return;
    }
    const { lines, partial } = readTranscriptLines(file);
    const m = analyze(lines);
    cfg.contextLimit = resolveContextLimit(cfg, m);
    const sig = signals(m, cfg);
    const ratio = m.ctx / cfg.contextLimit;
    console.log('=== lean report ===');
    if (info.fallback) {
      console.log(`(cwd에 세션 기록이 없어 최근 세션으로 대체: ${path.basename(file)})`);
    }
    console.log(`턴 수            : ${m.turns}${partial ? ' (일부 구간만 분석)' : ''}`);
    console.log(`현재 컨텍스트    : ${k(m.ctx)} / ${k(cfg.contextLimit)} (${pct(ratio)})`);
    const rc = recentCacheHit(m, cfg.cacheWindowTurns);
    console.log(
      `캐시 적중률      : 최근 ${rc ? rc.turns : 0}턴 ${rc ? pct(rc.hit) : '-'} / 누적 ${pct(m.cacheHit)}  (read ${k(m.cacheRead)} / create ${k(m.cacheCreate)})`
    );
    console.log(`캐시 TTL 분포    : 1h ${k(m.ephemeral1h)} / 5m ${k(m.ephemeral5m)}`);
    console.log(
      `누적 출력        : ${k(m.out)}  (턴당 ${Math.round(m.avgOut)}, effort=${m.effort || '?'}, 기준 ${Math.round(cfg.outputHeavy * (EFFORT_SCALE[m.effort] || 1))})`
    );
    console.log(`턴당 컨텍스트 증가: ${k(m.growth)}`);
    console.log(
      `서브에이전트     : ${m.sideTurns}콜, ${k(m.sideTokens)} 토큰` +
        (m.bgCalls
          ? ` (백그라운드 ${m.bgCalls}콜 ${k(m.bgTokens)}t / 툴 ${m.bgToolUses}회 / ${(m.bgMs / 1000).toFixed(0)}초)`
          : '')
    );
    console.log('--- 신호 ---');
    if (!sig.length) console.log('없음 — 현재 페이스 양호.');
    else for (const [key, msg] of sig) console.log(`[${key}] ${msg}`);
    return;
  }

  // 훅 모드
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (_) {
    input = {};
  }

  const transcript = input.transcript_path;
  const sessionId = input.session_id || input.sessionId;

  if (MODE === 'session-start') {
    if (!cfg.sessionCard) return;
    let extra = '';

    // Obsidian 볼트가 있으면 좌표를 알려준다. 없으면 조용히 넘어간다.
    if (cfg.obsidian) {
      try {
        const frag = require('./vault').cardFragment(cfg.vaultPath);
        if (frag) extra += '\n\n' + frag;
      } catch (_) {
        /* 볼트 모듈 문제는 세션을 방해하지 않는다 */
      }
    }

    try {
      if (transcript && fs.existsSync(transcript)) {
        const { lines } = readTranscriptLines(transcript);
        const m = analyze(lines);
        if (m.turns > 0) {
          const limit = resolveContextLimit(cfg, m);
          extra += `\n\n(이어받은 세션: 컨텍스트 ${k(m.ctx)} / ${k(limit)} ${pct(m.ctx / limit)})`;
        }
      }
    } catch (_) {
      /* 카드만 내보낸다 */
    }
    emit('SessionStart', CARD + extra);
    return;
  }

  // MODE === 'prompt'
  if (!transcript || !fs.existsSync(transcript)) return;

  let m;
  try {
    const { lines } = readTranscriptLines(transcript);
    m = analyze(lines);
  } catch (_) {
    return;
  }
  if (m.turns < 2) return;

  cfg.contextLimit = resolveContextLimit(cfg, m);
  const sig = signals(m, cfg);
  if (!sig.length) return;

  const keys = sig.map((s) => s[0]).sort().join(',');
  const state = loadState(sessionId);

  // 같은 신호 조합이면 최소 간격을 지킨다. 신호가 바뀌었으면 즉시 알린다.
  if (keys === state.lastKeys && m.turns - state.lastTurn < cfg.minTurnsBetweenNudges) return;

  saveState(sessionId, { lastTurn: m.turns, lastKeys: keys });

  const body = sig.map((s) => `- ${s[1]}`).join('\n');
  emit('UserPromptSubmit', `[lean] 지금 세션 상태에서 조정할 것:\n${body}`);
}

if (require.main === module) {
  try {
    main();
  } catch (_) {
    // 훅은 절대 세션을 방해하면 안 된다. 조용히 종료.
    process.exit(0);
  }
}

module.exports = {
  loadConfig,
  analyze,
  signals,
  recentCacheHit,
  resolveContextLimit,
  STD_LIMIT,
  BIG_LIMIT,
  readTranscriptLines,
  findLatestTranscript,
  projectSlug,
  EFFORT_SCALE,
  pct,
  k,
};
