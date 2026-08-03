#!/usr/bin/env node
/**
 * vault — Obsidian 볼트를 "제2의 저장소이자 뇌"로 쓰기 위한 해석/스캐폴드 모듈.
 *
 * 설계 원칙
 *  - 옵시디언이 없으면 조용히 아무것도 하지 않는다. 실패는 절대 세션을 방해하지 않는다.
 *  - 스캐폴드는 멱등이다. 이미 있으면 건드리지 않는다(사용자 노트를 절대 덮어쓰지 않는다).
 *  - 세션마다 볼트를 통독하지 않는다. INDEX.md 한 장만 진입점으로 두고, 필요할 때만 파고든다.
 *
 * 사용법
 *   node vault.js info    볼트 경로와 역할 폴더 상태를 출력
 *   node vault.js init    Claude 폴더 구조를 만든다(멱등)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 역할 폴더. 키는 폴더명, 값은 그 폴더에 무엇을 남기는지(INDEX.md용 설명). */
const ROLES = {
  '기획': '문제 정의, 요구사항, 완료 기준. 무엇을 왜 만드는가.',
  'PM': '범위, 순서, 결정 기록, 중단 조건. 왜 이 순서인가.',
  '개발': '구현 메모, 설계 판단, 함정과 해결. 코드가 말해주지 않는 것.',
  'UIUX': '화면 구조, 인터랙션 결정, 디자인 토큰, 사용성 지적.',
  '보안점검': '점검 항목과 결과, 발견된 위험, 조치와 잔여 위험.',
  '데브옵스': '빌드·배포·검증 절차, 실패 패턴, 롤백 방법.',
  '리서치': '조사 결과와 출처. 다시 찾지 않기 위한 기록.',
};

const ROOT = 'Claude';

/* ---------------------------------------------------------------- resolve */

function obsidianConfigPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appdata, 'obsidian', 'obsidian.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'obsidian', 'obsidian.json');
}

/**
 * 열려 있는 볼트를 우선, 없으면 가장 최근에 쓴 볼트를 고른다.
 * 옵시디언이 없거나 볼트가 없으면 null.
 */
function resolveVault(override) {
  if (override) return fs.existsSync(override) ? override : null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(obsidianConfigPath(), 'utf8'));
  } catch (_) {
    return null;
  }
  const vaults = (cfg && cfg.vaults) || {};
  let best = null;
  let bestScore = -1;
  for (const v of Object.values(vaults)) {
    if (!v || !v.path || !fs.existsSync(v.path)) continue;
    // 열려 있는 볼트가 무조건 우선, 그다음 최근 사용 순
    const score = (v.open ? 1e15 : 0) + (v.ts || 0);
    if (score > bestScore) {
      bestScore = score;
      best = v.path;
    }
  }
  return best;
}

/* --------------------------------------------------------------- scaffold */

const INDEX_HEADER = `---
tags: [claude, index]
---

# Claude 작업 저장소

Claude Code가 세션 중 남기는 산출물이 역할별로 쌓이는 곳이다.
새 작업을 시작하기 전에 관련 역할 폴더를 먼저 확인하면, 이미 내린 결정을 다시 내리지 않는다.

## 역할 폴더
`;

const INDEX_FOOTER = `
## 노트 규칙

- 경로: \`${ROOT}/<역할>/<프로젝트> - <주제>.md\`
- 프론트매터에 \`role\`, \`project\`, \`created\`를 반드시 넣는다 — 나중에 Dataview로 질의하기 위해서다.
- 코드를 통째로 붙여넣지 않는다. 저장소에 있는 것은 \`file.ts:42\`로 가리킨다.
- 관련 노트는 \`[[노트 이름]]\`으로 연결한다. 아직 없는 이름을 걸어도 된다 — 나중에 쓸 것이라는 표시가 된다.
- 이미 있는 노트를 갱신할 수 있으면 새로 만들지 않는다.

이 파일은 lean 플러그인이 생성했다. 자유롭게 고쳐도 되며 덮어쓰지 않는다.
`;

function ensureScaffold(vaultPath) {
  const root = path.join(vaultPath, ROOT);
  const created = [];
  try {
    for (const role of Object.keys(ROLES)) {
      const dir = path.join(root, role);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(role);
      }
    }
    const index = path.join(root, 'INDEX.md');
    if (!fs.existsSync(index)) {
      const body =
        INDEX_HEADER +
        Object.entries(ROLES)
          .map(([role, desc]) => `- **${role}** — ${desc}`)
          .join('\n') +
        '\n' +
        INDEX_FOOTER;
      fs.writeFileSync(index, body, 'utf8');
      created.push('INDEX.md');
    }
  } catch (_) {
    return null; // 권한 문제 등 — 조용히 포기
  }
  return { root, created };
}

/* ------------------------------------------------------------------ stats */

/** 역할별 노트 개수. 볼트를 통독하지 않고 파일명만 센다. */
function roleCounts(root) {
  const out = {};
  for (const role of Object.keys(ROLES)) {
    try {
      out[role] = fs
        .readdirSync(path.join(root, role))
        .filter((f) => f.endsWith('.md')).length;
    } catch (_) {
      out[role] = 0;
    }
  }
  return out;
}

/**
 * 세션 시작 카드에 붙일 조각. 볼트가 없으면 빈 문자열.
 * 노트를 읽어 오지 않는다 — 어디에 무엇이 있는지 좌표만 알려준다.
 */
function cardFragment(override) {
  const vault = resolveVault(override);
  if (!vault) return '';
  const scaffold = ensureScaffold(vault);
  if (!scaffold) return '';

  const counts = roleCounts(scaffold.root);
  const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0);
  const total = nonEmpty.reduce((a, [, n]) => a + n, 0);

  const lines = [
    '## 제2 저장소 — Obsidian',
    `볼트: ${scaffold.root}`,
    '역할 산출물은 여기에 남긴다. 세션이 끝나면 사라지는 대화와 달리 다음 세션이 이어받는다.',
    '- 경로: `<역할>/<프로젝트> - <주제>.md` (역할: ' + Object.keys(ROLES).join(' / ') + ')',
    '- 프론트매터에 `role`, `project`, `created`(YYYY-MM-DD)를 넣는다.',
    '- **쓰기**: 되풀이될 판단(설계 결정, 함정, 점검 결과, 합의된 범위)을 남긴다.',
    '  코드가 이미 말해주는 것, 이 대화에서만 의미 있는 것은 남기지 않는다.',
    '- **읽기**: 같은 프로젝트를 다시 만지기 전에 해당 역할 폴더를 Glob으로 확인한다.',
    '  전체를 통독하지 말고 제목으로 고른 뒤 필요한 것만 Read.',
    '- 이미 있는 노트는 새로 만들지 말고 갱신한다. 관련 노트는 `[[이름]]`으로 연결한다.',
  ];

  if (total > 0) {
    lines.push(
      `- 현재 보유: ${nonEmpty.map(([r, n]) => `${r} ${n}`).join(', ')} (총 ${total}개)`
    );
  } else {
    lines.push('- 현재 비어 있음. 이번 세션의 판단부터 쌓기 시작한다.');
  }

  if (scaffold.created.length) {
    lines.push(`- (폴더 생성됨: ${scaffold.created.join(', ')})`);
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------- main */

if (require.main === module) {
  const mode = process.argv[2] || 'info';
  const i = process.argv.indexOf('--vault');
  const override = i > -1 ? process.argv[i + 1] : null;
  const vault = resolveVault(override);

  if (!vault) {
    console.log('Obsidian 볼트를 찾지 못했습니다. (미설치이거나 볼트가 없음)');
    process.exit(0);
  }
  console.log(`볼트: ${vault}`);

  if (mode === 'init') {
    const s = ensureScaffold(vault);
    if (!s) {
      console.log('스캐폴드 생성 실패 (권한 확인 필요)');
      process.exit(0);
    }
    console.log(`루트: ${s.root}`);
    console.log(s.created.length ? `생성: ${s.created.join(', ')}` : '이미 구성되어 있음');
    return;
  }

  const s = ensureScaffold(vault);
  if (s) {
    const counts = roleCounts(s.root);
    console.log(`루트: ${s.root}`);
    for (const [role, n] of Object.entries(counts)) {
      console.log(`  ${role.padEnd(6)} ${n}개`);
    }
  }
}

module.exports = { resolveVault, ensureScaffold, roleCounts, cardFragment, ROLES, ROOT };
