#!/bin/bash
# 붕어빵 앱 배포게이트(범용) — 생성된 out/<app>/ 에 복사되어 그 폴더에서 실행.
# ① 치환누락 {{...}} 유출 ② 전 JS 신택스 ③ 런타임크래시(runtime-check.js 있으면) ④ 계측계약(ALLOWED.txt 있으면).
# 통과(exit 0)해야 배포. 새 미니앱은 이 게이트가 기본탑재(2026-07-16 Morpheus, p2게이트 일반화).
cd "$(dirname "$0")" || exit 1
FAIL=0

echo "── 1) 치환누락 플레이스홀더 유출 검사"
LEAK=$(grep -rlE '\{\{[A-Z_]+\}\}' . --include='*.js' --include='*.html' --include='*.css' 2>/dev/null | grep -v verify.sh)
if [ -z "$LEAK" ]; then echo "  ✅ {{...}} 잔존 없음"; else echo "  🔴 미치환 플레이스홀더 유출:"; echo "$LEAK" | sed 's/^/    /'; FAIL=1; fi

echo "── 2) 문법 체크(전 JS)"
for f in $(find . -maxdepth 2 -name '*.js' -not -name '*.min.js' 2>/dev/null); do
  if node --check "$f" 2>/dev/null; then echo "  ✅ $(basename "$f")"; else echo "  🔴 $(basename "$f") 신택스"; FAIL=1; fi
done

echo "── 3) 런타임 크래시 게이트"
if [ -f test/runtime-check.js ]; then
  if node test/runtime-check.js >/tmp/mini-rt.log 2>&1; then echo "  ✅ 런타임 클린"; else echo "  🔴 런타임 크래시:"; tail -6 /tmp/mini-rt.log | sed 's/^/    /'; FAIL=1; fi
else echo "  ⚪ runtime-check.js 없음(앱 조립 후 추가) — 스킵"; fi

echo "── 4) 계측 계약"
if [ -f ALLOWED.txt ]; then
  MISS=""
  for e in $(grep -rhoE "emit(Env)?\('[A-Za-z0-9_.]+'" . --include='*.js' 2>/dev/null | grep -oE "'[A-Za-z0-9_.]+'" | tr -d "'" | sort -u); do
    grep -qxF "$e" ALLOWED.txt || MISS="$MISS $e"
  done
  if [ -z "$MISS" ]; then echo "  ✅ 계측 계약 OK"; else echo "  🔴 ALLOWED.txt 누락:$MISS"; FAIL=1; fi
else echo "  ⚪ ALLOWED.txt 없음 — 스킵(권장: emit 이벤트명 화이트리스트)"; fi

echo "── 5) 공유 귀속 감사 (K팩터 누수 방지 — 2026-07-20 p2에서 실증된 버그)"
# t.me/share/url 공유가 window.location / location.href(날 웹URL)를 실으면 귀속0·브라우저열림 → 바이럴 죽음.
SHARE_LEAK=$(grep -rnE "share/url\?url=[^&]*(window\.location|location\.href|location\.origin)" . --include='*.js' 2>/dev/null | grep -v verify.sh)
if [ -z "$SHARE_LEAK" ]; then echo "  ✅ 공유경로 귀속 OK (날 웹URL 공유 없음)"; else echo "  🔴 공유 귀속 누수(초대 딥링크 대신 날URL):"; echo "$SHARE_LEAK" | sed 's/^/    /'; FAIL=1; fi

echo "──────────────"
if [ "$FAIL" -eq 0 ]; then echo "🟢 검증 통과 — 배포 OK"; exit 0; else echo "🔴 검증 실패 — 배포 중단"; exit 1; fi
