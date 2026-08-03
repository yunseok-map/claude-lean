# lean

Claude Code가 **적은 토큰으로 빠르게** 일하도록 만드는 플러그인.

툴을 막거나 규칙을 강제하지 않는다. 대신 세션의 실제 상태(컨텍스트 점유율, 캐시 적중률,
출력량, 서브에이전트 비중)를 읽어서 **지금 무엇을 바꾸면 되는지**만 알려준다.
판단은 모델이 한다.

## 구성

| 요소 | 시점 | 하는 일 |
|---|---|---|
| `SessionStart` 훅 | 세션 시작·재개·압축 직후 | 압축된 작업 원칙 카드 1회 주입 (~150토큰, 이후 캐시에 얹혀 사실상 무료) |
| `UserPromptSubmit` 훅 | 매 프롬프트 | 트랜스크립트 분석 → **신호가 잡혔고 직전과 달라졌을 때만** 1~2줄 주입 |
| `lean` 스킬 | 모델이 필요할 때 | 탐색·병렬화·캐시·위임 전술 전체 플레이북 |
| `/lean` 커맨드 | 사용자 호출 | 현재 세션 리포트 + 해석 3줄 |

## 신호 종류

- `ctx-warn` / `ctx-high` — 컨텍스트 점유율 55% / 75%
- `cache-churn` — 캐시 적중률 55% 미만 (앞쪽 컨텍스트가 계속 재생성되는 중)
- `verbose` — 턴당 출력 과다. **effort 설정에 따라 임계치가 자동 보정**된다(thinking 토큰이 output에 포함되므로)
- `growth` — 턴당 컨텍스트 증가량 과다 (툴 출력이 큼)
- `subagent` — 서브에이전트 토큰 비중 30% 초과

같은 신호는 최소 3턴 간격으로만 다시 뜬다. 신호가 없으면 **아무것도 출력하지 않는다.**

## 설치

```
/plugin marketplace add <조직>/claude-lean
/plugin install lean@lean
```

팀 전체에 뿌릴 때는 사내 표준 `~/.claude/settings.json`에 마켓플레이스를 미리 넣어두면
각자 `/plugin install`만 하면 된다.

```json
{
  "extraKnownMarketplaces": {
    "lean": { "source": { "source": "github", "repo": "<조직>/claude-lean" } }
  }
}
```

## 설정

`~/.claude/lean.config.json` 또는 프로젝트의 `.claude/lean.config.json`으로 덮어쓴다.
(프로젝트 설정이 우선)

```json
{
  "contextLimit": 200000,
  "ctxWarn": 0.55,
  "ctxHigh": 0.75,
  "cacheHitFloor": 0.55,
  "outputHeavy": 1600,
  "ctxGrowthHeavy": 14000,
  "sidechainShare": 0.3,
  "minTurnsBetweenNudges": 3,
  "sessionCard": true,
  "enabled": true
}
```

- 1M 컨텍스트를 쓰면 `contextLimit`을 `1000000`으로.
- 카드 주입이 거슬리면 `sessionCard: false` (신호 훅은 계속 동작).
- 잠시 끄려면 `enabled: false`.

## 동작 확인

플러그인 설치 없이도 스크립트만 직접 돌려볼 수 있다.

```bash
node plugins/lean/scripts/lean.js report
```

## 요구사항

Node 18+ (표준 라이브러리만 사용, 의존성 없음). Windows / macOS / Linux 공통.
