/**
 * 운영자 큐레이션 — 코드로 관리하는 시드·차단 지갑. 화면의 시드 추가와 같은 효과이고, 배포마다 적용된다.
 * 근거는 옆에 적는다. 숫자는 우리 스트림이 실제로 본 왕복 기준 (docs/pumpfun.md "지갑 채점").
 */
export const CURATED_SEEDS: Array<{ wallet: string; why: string; since: string }> = [
  // 2026-09-25 12:42 관측: 왕복 24 · 토큰 2 · 승률 92% · 중앙값 +17.5% · 총 +0.93 SOL / 거래대금 17 SOL · 보유 중앙값 9.6분.
  // 보유가 길어(9.6분) 몇 초 지연으로 따라갈 수 있고 중앙값이 카피 왕복 비용(~4%)을 넉넉히 넘는다.
  { wallet: "4CzBzJRisBmCpts3RrFKagVSkYGWMaecPj7vKDfeRXgA", why: "hold 9.6m · median +17.5% · win 92% · 24 rt", since: "2026-09-25" },
];

export const CURATED_BLOCKED: Array<{ wallet: string; why: string }> = [
  // 왕복 347 · 토큰 138 · 중앙값 +0.4% · 보유 2.7분 — 실력은 있지만 **카피 불가**: 우리 왕복 비용이 3.5%라 따라가면 구조적으로 진다. 실측 11회 연속 손실
  { wallet: "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51", why: "HFT, median +0.4% < copy cost — copies lost 11/11" },
  // 승률 100%·중앙값 +13.8% 인데 첫 카피가 2분 만에 −67%(페이퍼)·−99%(실) — 우리가 사면 이미 팔고 나간 뒤다 (스나이퍼형)
  { wallet: "AY9k1PRTsDzwBzF4nNwWHc8m6bnG1e1qrdMZ9VpLWdLz", why: "exits seconds after entry — first copy −67%/−99%" },
];

const blocked = new Set(CURATED_BLOCKED.map((b) => b.wallet));
export const isBlockedWallet = (w: string) => blocked.has(w);
