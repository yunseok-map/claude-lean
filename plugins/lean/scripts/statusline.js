#!/usr/bin/env node
/**
 * statusline — 모델 / 캐시 적중 / 컨텍스트 / 절감액 / 절감 토큰을 한 줄로.
 *
 * Claude Code가 stdin으로 JSON을 준다(model, workspace, session_id, transcript_path...).
 * 실제 수치는 트랜스크립트의 message.usage에서 직접 계산한다.
 *
 *   settings.json:
 *   "statusLine": { "type": "command",
 *                   "command": "node \"<플러그인>/scripts/statusline.js\"",
 *                   "refreshInterval": 5 }
 */
'use strict';

const fs = require('fs');
const lean = require('./lean');

/* ----------------------------------------------------------------- 단가표 */

/**
 * $ / 1M 토큰. 캐시 단가는 base input에 대한 배수로 계산한다.
 *   cache read  = input × 0.1
 *   cache write = input × 1.25 (5m TTL) 또는 × 2.0 (1h TTL)
 * 출처: claude-api 스킬 단가표 (2026-06-24 기준).
 */
const PRICES = [
  [/fable|mythos/, { in: 10, out: 50 }],
  [/opus-5/, { in: 5, out: 25, fast: { in: 10, out: 50 } }],
  [/opus/, { in: 5, out: 25 }],
  // Sonnet 5는 2026-08-31까지 도입 가격($2/$10)
  [/sonnet-5/, { in: 3, out: 15, introUntil: '2026-08-31', intro: { in: 2, out: 10 } }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku/, { in: 1, out: 5 }],
];

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = { '5m': 1.25, '1h': 2.0 };

function priceFor(modelId, speed) {
  const id = String(modelId || '').toLowerCase();
  for (const [re, p] of PRICES) {
    if (!re.test(id)) continue;
    if (speed === 'fast' && p.fast) return p.fast;
    if (p.intro && p.introUntil && new Date() <= new Date(p.introUntil + 'T23:59:59Z')) {
      return p.intro;
    }
    return { in: p.in, out: p.out };
  }
  return null; // 모르는 모델이면 금액 칩을 생략한다
}

/* ------------------------------------------------------------------- 색상 */

// NO_COLOR 환경변수를 존중한다(https://no-color.org).
const USE_COLOR = !process.env.NO_COLOR;
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const c = (color, s) => (USE_COLOR ? C[color] + s + C.reset : String(s));
/** 값이 좋으면 초록, 애매하면 노랑, 나쁘면 빨강 */
const grade = (v, goodAbove, okAbove) =>
  v >= goodAbove ? 'green' : v >= okAbove ? 'yellow' : 'red';

/* ------------------------------------------------------------------- 포맷 */

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function k(n) {
  const v = Math.round(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(v % 1e6 === 0 || v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return String(v);
}

function money(d) {
  if (d >= 100) return `$${d.toFixed(0)}`;
  if (d >= 10) return `$${d.toFixed(1)}`;
  return `$${d.toFixed(2)}`;
}

/** 컨텍스트 점유율 5칸 게이지 */
function gauge(ratio) {
  const filled = Math.min(5, Math.max(0, Math.round(ratio * 5)));
  return '▮'.repeat(filled) + '▯'.repeat(5 - filled);
}

/** mm:ss 카운트다운 */
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 캐시 만료까지 남은 시간. 마지막 턴 시각 + TTL 기준.
 * TTL은 이 세션이 실제로 쓴 분포에서 고른다(1h가 잡혔으면 1h).
 */
function cacheExpiry(m) {
  if (!m.lastTs) return null;
  const ttlMs = m.ephemeral1h >= m.ephemeral5m ? 60 * 60 * 1000 : 5 * 60 * 1000;
  return { left: m.lastTs + ttlMs - Date.now(), ttlMs };
}

/* ------------------------------------------------------------------- 계산 */

/**
 * 캐시가 없었다면 냈을 비용과 실제 비용의 차이.
 *   없었다면: (cacheRead + cacheCreate) × input단가
 *   실제:     cacheRead × 0.1 + cacheCreate × (1.25 또는 2.0)
 * 1h TTL은 쓰기가 2배라 재사용이 적으면 음수가 나올 수 있다 — 그대로 보여준다.
 */
function cacheSavings(m, price) {
  if (!price) return null;
  const rate = price.in / 1e6;
  const total1h = m.ephemeral1h;
  const total5m = m.ephemeral5m;
  const writeCost =
    (total1h * CACHE_WRITE_MULT['1h'] + total5m * CACHE_WRITE_MULT['5m']) * rate;
  // TTL 분포를 모르는 잔여분은 5m로 가정
  const untagged = Math.max(0, m.cacheCreate - total1h - total5m);
  const writeCostFull = writeCost + untagged * CACHE_WRITE_MULT['5m'] * rate;

  const readCost = m.cacheRead * CACHE_READ_MULT * rate;
  const naive = (m.cacheRead + m.cacheCreate) * rate;
  return {
    usd: naive - (readCost + writeCostFull),
    // 과금 기준 "안 낸 입력 토큰" — 캐시 읽기의 90%
    tokens: m.cacheRead * (1 - CACHE_READ_MULT),
  };
}

/* -------------------------------------------------------------------- main */

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch (_) {
    input = {};
  }

  const cfg = lean.loadConfig();
  const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || process.cwd();
  const transcript = input.transcript_path || lean.findLatestTranscript(cwd);

  const display =
    (input.model && (input.model.display_name || input.model.id)) || null;

  if (!transcript || !fs.existsSync(transcript)) {
    process.stdout.write(display || 'Claude');
    return;
  }

  let m;
  try {
    m = lean.analyze(lean.readTranscriptLines(transcript).lines);
  } catch (_) {
    process.stdout.write(display || 'Claude');
    return;
  }

  const modelId = (input.model && input.model.id) || m.model;
  const price = priceFor(modelId, m.speed);
  const save = cacheSavings(m, price);
  // 설정이 "auto"면 관측값으로 판별한다 — 개인 환경(200k)과 회사 환경(1M)에
  // 같은 설정을 써도 각자 맞게 잡힌다.
  cfg.contextLimit = lean.resolveContextLimit(cfg, m);
  const ratio = m.ctx / cfg.contextLimit;

  const chips = [];

  // 1M 창이 실제로 켜져 있을 때만 표시한다
  if (cfg.contextLimit >= lean.BIG_LIMIT) chips.push(c('red', '⚠ 1M ON'));

  // 모델
  let name = `🤖 ${display || modelId || 'Claude'}`;
  if (m.speed === 'fast') name += ' ⚡fast';
  chips.push(c('magenta', name));

  if (m.turns > 0) {
    // 캐시 적중률
    chips.push(
      `${c('bold', '🧠 Cache hit')} ${c(grade(m.cacheHit, 0.8, 0.55), pct(m.cacheHit))}`
    );

    // 캐시 만료 카운트다운
    const exp = cacheExpiry(m);
    if (exp) {
      const label = exp.left <= 0 ? '⌛ Cache expired' : `⏳ Cache expires ${clock(exp.left)}`;
      chips.push(c(grade(exp.left, 5 * 60 * 1000, 60 * 1000), label));
    }

    // 컨텍스트 — 게이지 + 절대치 + 점유율
    chips.push(
      c(
        grade(1 - ratio, 0.6, 0.3),
        `📦 ${gauge(ratio)} Ctx ${k(m.ctx)}/${k(cfg.contextLimit)} ${pct(ratio)}`
      )
    );

    // 캐시 수지. 아직 읽기가 없으면 쓰기 프리미엄만 나가서 음수가 된다 —
    // 그걸 "saved"로 부르면 거짓말이므로 라벨을 나눈다.
    if (save) {
      if (save.usd < 0) {
        chips.push(`${c('yellow', '💰 Cache cost')} ${money(-save.usd)}`);
      } else {
        chips.push(`${c('cyan', '💰 Cache saved')} ${money(save.usd)}`);
      }
      if (save.tokens >= 1000) {
        chips.push(`${c('cyan', '🎫 Tokens saved')} ${k(save.tokens)}`);
      }
    }

    // lean 신호가 잡혔으면 키만 짧게
    try {
      const sig = lean.signals(m, cfg);
      if (sig.length) chips.push(c('red', '⚠ ' + sig.map((s) => s[0]).join(' ')));
    } catch (_) {
      /* 신호는 부가 정보 */
    }

    chips.push(c('dim', `${m.turns} turns`));
  }

  process.stdout.write(chips.join(c('dim', ' · ')));
}

try {
  main();
} catch (_) {
  // 스테이터스라인이 세션을 방해해선 안 된다.
  process.stdout.write('Claude');
}
