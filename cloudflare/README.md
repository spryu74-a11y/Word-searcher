# Cloudflare 엣지 배포

이 구성은 GitHub Pages와 별도로 선택해 사용할 수 있는 운영용 엣지입니다.
정적 자산은 Cloudflare Assets에서 전달하고 `/api/opendict/search`만 Worker가
처리하므로, 원본 Python 서버를 인터넷에 직접 노출하지 않습니다.

1. 계정에서 Rate Limiting namespace를 2개 만들고
   `wrangler.jsonc`의 `1001`, `1002` 예시 ID를 실제 고유 ID로 교체
2. `cloudflare`에서 `npm install` 후 `npm run check` 실행
3. `npx wrangler@latest secret put OPENDICT_API_KEY` 실행
4. Wrangler 4.36 이상으로 `npx wrangler@latest deploy` 실행

Rate Limiting binding의 namespace ID는 계정 내에서 고유해야 합니다. Worker의
rate limit은 POP 단위로 동작하므로, 대규모 공격에는 Cloudflare WAF/Rate
Limiting 규칙을 도메인에도 함께 적용해야 합니다. GitHub Pages만 계속 사용할
경우 이 Worker 설정은 자동 적용되지 않습니다. GitHub Pages를 계속 쓸
경우에는 `python tools/build_secure_site.py --output <배포폴더>`로 원천
데이터와 도구를 제외한 정적 표면만 배포하세요.
