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
  // 컨텍스트 한도. 회사 정책이 1M이므로 기본값이 1000000이다.
  // 200k 컨텍스트를 쓰는 환경은 200000으로 덮어쓴다.
  contextLimit: 1000000,
  // 컨텍스트 점유율 임계치
  ctxWarn: 0.55,
  ctxHigh: 0.75,
  // 점유율과 별개로, 이 크기를 넘으면 캐시 적중이어도 턴당 비용이 붙는다.
  // 1M 창에서는 55%(550k)까지 기다리면 이미 많이 쓴 뒤이므로 절대 기준이 필요하다.
  ctxCostFloor: 250000,
  // 캐시 적중률이 이 아래로 떨어지면 컨텍스트가 흔들리고 있다는 뜻
  cacheHitFloor: 0.55,
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

/** 훅 stdin 없이 호출됐을 때 현재 cwd의 최신 트랜스크립트를 찾는다. */
function findLatestTranscript(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug(cwd));
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
  return best;
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
  const side = new Map();
  let effort = null;
  let model = null;
  let speed = null;
  let lastTs = 0;

  for (const line of lines) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
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

  if (m.turns >= 4 && m.cacheHit < cfg.cacheHitFloor) {
    out.push([
      'cache-churn',
      `캐시 적중 ${pct(m.cacheHit)}. 앞쪽 컨텍스트가 계속 재생성되고 있다 — 이미 읽은 것을 다시 끌어오지 말고 뒤에 덧붙이는 방향으로 진행해라.`,
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
    const file = arg('--transcript') || findLatestTranscript(cwd);
    if (!file || !fs.existsSync(file)) {
      console.log('lean: 트랜스크립트를 찾지 못했습니다.');
      return;
    }
    const { lines, partial } = readTranscriptLines(file);
    const m = analyze(lines);
    const sig = signals(m, cfg);
    const ratio = m.ctx / cfg.contextLimit;
    console.log('=== lean report ===');
    console.log(`턴 수            : ${m.turns}${partial ? ' (일부 구간만 분석)' : ''}`);
    console.log(`현재 컨텍스트    : ${k(m.ctx)} / ${k(cfg.contextLimit)} (${pct(ratio)})`);
    console.log(`캐시 적중률      : ${pct(m.cacheHit)}  (read ${k(m.cacheRead)} / create ${k(m.cacheCreate)})`);
    console.log(`캐시 TTL 분포    : 1h ${k(m.ephemeral1h)} / 5m ${k(m.ephemeral5m)}`);
    console.log(
      `누적 출력        : ${k(m.out)}  (턴당 ${Math.round(m.avgOut)}, effort=${m.effort || '?'}, 기준 ${Math.round(cfg.outputHeavy * (EFFORT_SCALE[m.effort] || 1))})`
    );
    console.log(`턴당 컨텍스트 증가: ${k(m.growth)}`);
    console.log(`서브에이전트     : ${m.sideTurns}콜, ${k(m.sideTokens)} 토큰`);
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
          extra += `\n\n(이어받은 세션: 컨텍스트 ${k(m.ctx)} / ${pct(m.ctx / cfg.contextLimit)})`;
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
  readTranscriptLines,
  findLatestTranscript,
  projectSlug,
  EFFORT_SCALE,
  pct,
  k,
};
