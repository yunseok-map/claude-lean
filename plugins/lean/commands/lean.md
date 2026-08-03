---
description: 현재 세션의 토큰·컨텍스트·캐시 상태 리포트와 지금 바꿀 점
---

lean 리포트 스크립트를 실행해서 현재 세션 상태를 확인해라.

1. Bash 툴로 실행한다:
   `node "$CLAUDE_PLUGIN_ROOT/scripts/lean.js" report`

2. `$CLAUDE_PLUGIN_ROOT`가 비어 있어서 실패하면, Glob으로 `**/plugins/**/lean/scripts/lean.js`를
   찾아 그 경로로 다시 실행해라.

3. 출력을 그대로 붙여넣지 말고, **3줄 이내**로 해석해서 답해라:
   - 지금 상태 한 줄 (컨텍스트 점유율 / 캐시 적중률)
   - 가장 비용이 큰 지점 한 줄
   - 지금부터 바꿀 것 한 줄 (없으면 "조정 불필요")

리포트에 신호가 없으면 "현재 페이스 양호"만 답하고 끝내라.
