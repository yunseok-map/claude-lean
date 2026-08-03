# lean

Claude Code가 **1인 IT팀처럼 일하되, 적은 토큰으로 빠르게** 움직이도록 만드는 플러그인.

툴을 막거나 규칙을 강제하지 않는다. 세션의 실제 상태를 읽어서 **지금 무엇을 바꾸면 되는지**만 알려주고,
판단은 모델이 한다.

## 네 가지 축

### 1. 역할 게이트 (1인 IT팀)

기획 / PM / 개발 / 데브옵스를 순서대로 통과하되, **역할은 별도 에이전트가 아니라 체크포인트**다.
역할별로 서술하면 그 자체가 토큰이고, 역할마다 에이전트를 띄우면 컨텍스트를 네 번 다시 쌓는다.
각 역할은 정해진 형식의 짧은 산출물만 낸다.

작업 크기가 어느 역할까지 켤지 정한다 — 작은 일에 전 역할을 켜는 것이 가장 큰 낭비다.

| 크기 | 켜는 역할 |
|---|---|
| XS (파일 1개, 툴콜 1~2회) | 개발만 |
| S (툴콜 2~5회) | PM 한 줄 + 개발 + 검증 한 줄 |
| M (파일 여러 개 / 불확실) | 네 역할 전부 |
| L (새 기능·마이그레이션) | 전부 + 착수 전 확인 |

### 2. 위임 라우팅 (멀티 에이전트)

전용 서브에이전트 3종을 포함한다. 핵심은 프롬프트가 아니라 **출력 계약** — 각 에이전트는 고정된
형식만 반환하므로, 부모는 트랜스크립트가 아니라 압축된 산출물을 받는다.

| 에이전트 | 모델 | 도구 | 돌려주는 것 |
|---|---|---|---|
| `scout` | haiku | Glob, Grep, Read | 좌표 목록 15개 이내. **본문 인용 금지** |
| `architect` | inherit | Glob, Grep, Read | 실행 가능한 단계 8개 이내 + 위험 + 검증 명령 |
| `ops` | sonnet | Bash, Read, Grep, Glob | PASS/FAIL + 실패 원인 + 로그 15줄 이내 |

내장 `Explore` / `Plan` / `general-purpose`로 가는 조건도 라우팅 표에 함께 들어간다.
**코드 수정은 위임하지 않는다** — 편집 맥락을 잃으면 결국 다시 읽게 된다.

### 3. 제2 저장소 (Obsidian)

옵시디언이 깔려 있으면 볼트를 자동 탐지해 `Claude/` 아래에 역할 폴더를 만든다.

```
Claude/
├─ INDEX.md
├─ 기획/      문제 정의, 요구사항, 완료 기준
├─ PM/        범위, 순서, 결정 기록
├─ 개발/      설계 판단, 함정과 해결
├─ UIUX/      화면 구조, 인터랙션 결정
├─ 보안점검/   점검 결과, 위험, 잔여 위험
├─ 데브옵스/   빌드·배포 절차, 실패 패턴
└─ 리서치/    조사 결과와 출처
```

노트는 `<역할>/<프로젝트> - <주제>.md`, 프론트매터에 `role`·`project`·`created`가 들어가 Dataview로 질의된다.
**읽기 규칙이 더 중요하다** — 볼트를 통독하지 않고 Glob으로 제목만 훑은 뒤 필요한 것만 Read.
기존 사용자 노트는 절대 덮어쓰지 않는다(멱등 스캐폴드).

### 4. 신호 + 스테이터스라인

| 요소 | 시점 | 하는 일 |
|---|---|---|
| `SessionStart` 훅 | 세션 시작·재개·압축 직후 | 작업 카드 + 볼트 좌표 1회 주입 (이후 캐시에 얹혀 사실상 무료) |
| `UserPromptSubmit` 훅 | 매 프롬프트 | **신호가 잡혔고 직전과 달라졌을 때만** 1~2줄 |
| 스테이터스라인 | 상시 | 모델 / 캐시 적중 / 컨텍스트 / 절감액 / 절감 토큰 |
| `lean` 스킬 | 모델이 필요할 때 | 전체 플레이북 |
| `/lean` 커맨드 | 사용자 호출 | 세션 리포트 + 해석 3줄 |

```
Opus 5 │ 🧠 96% │ ▮▮▯▯▯ ctx 427k/1M 43% │ 💰 $38.8 │ 🎫 8.2M saved │ ⚠ ctx-cost
```

절감액은 추정이 아니라 실단가 계산이다 — 캐시 read는 base input의 0.1배, write는 5m TTL 1.25배 /
1h TTL 2배. 모델별 단가표가 들어 있고 fast mode와 Sonnet 5 도입가(2026-08-31까지)도 반영한다.
1M 컨텍스트에는 long-context 프리미엄이 없으므로 별도 보정을 하지 않는다.

## 신호 종류

- `ctx-cost` — 컨텍스트 250k 초과. **1M 창에서 특히 중요**: 점유율은 낮아도 그 크기가 매 턴 다시 계산된다
- `ctx-warn` / `ctx-high` — 점유율 55% / 75%
- `cache-churn` — 캐시 적중률 55% 미만 (앞쪽 컨텍스트가 재생성되는 중)
- `verbose` — 턴당 출력 과다. **effort에 따라 임계치 자동 보정** (thinking이 output에 포함되므로)
- `growth` — 턴당 컨텍스트 증가량 과다
- `subagent` — 서브에이전트 토큰 비중 30% 초과

같은 신호는 최소 3턴 간격으로만 다시 뜬다. 신호가 없으면 **아무것도 출력하지 않는다.**

## 설치

```
/plugin marketplace add <조직>/claude-lean
/plugin install lean@lean
```

스테이터스라인은 플러그인이 아니라 `settings.json`에 직접 넣는다(한 세션에 하나만 가능).

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"<플러그인 경로>/scripts/statusline.js\"",
    "refreshInterval": 5
  }
}
```

팀 배포 시에는 마켓플레이스를 사내 표준 `settings.json`에 미리 넣어두면 각자 `/plugin install`만 하면 된다.

```json
{
  "extraKnownMarketplaces": {
    "lean": { "source": { "source": "github", "repo": "<조직>/claude-lean" } }
  }
}
```

## 설정

`~/.claude/lean.config.json` 또는 프로젝트의 `.claude/lean.config.json` (프로젝트가 우선).

```json
{
  "contextLimit": "auto",
  "ctxWarn": 0.55,
  "ctxHigh": 0.75,
  "ctxCostFloor": 250000,
  "cacheHitFloor": 0.55,
  "outputHeavy": 1600,
  "ctxGrowthHeavy": 14000,
  "sidechainShare": 0.3,
  "minTurnsBetweenNudges": 3,
  "sessionCard": true,
  "obsidian": true,
  "vaultPath": null,
  "enabled": false
}
```

- `contextLimit`은 기본 `"auto"` — 컨텍스트가 200k를 넘은 적이 있으면 1M 창이 켜져 있다는
  확정적 증거이므로 1M으로 잡고, 그 사실을 `~/.claude/lean-state/context-limit.json`에 기억한다.
  세션 초반엔 아직 작아서 판별이 안 되므로 기억이 필요하다. **개인 환경(200k)과 회사 환경(1M)에
  같은 설정 파일을 써도 각자 맞게 잡힌다.** 환경이 바뀌면 그 파일을 지우면 재판별한다.
  강제로 고정하려면 숫자를 직접 넣는다(`200000` / `1000000`).
- 옵시디언 연동만 끄려면 `obsidian: false`. 볼트 자동 탐지가 틀리면 `vaultPath`로 지정.
- 카드 주입이 거슬리면 `sessionCard: false` (신호 훅은 계속 동작).
- 전부 끄려면 `enabled: false`.

## 동작 확인

플러그인 설치 없이도 스크립트만 직접 돌려볼 수 있다.

```bash
node plugins/lean/scripts/lean.js report      # 세션 리포트
node plugins/lean/scripts/vault.js info       # 볼트 경로와 역할별 노트 수
node plugins/lean/scripts/vault.js init       # 폴더 구조 생성(멱등)
```

## 요구사항

Node 18+ (표준 라이브러리만 사용, 의존성 없음). Windows / macOS / Linux 공통.
옵시디언 연동은 선택 — 없으면 해당 기능만 조용히 비활성화된다.
