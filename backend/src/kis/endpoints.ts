/**
 * KIS Open API — 해외주식(미국) 관련 엔드포인트/TR ID 모음.
 *
 * ⚠️ TR ID는 KIS Developers 공식 문서 기준으로 반드시 재검증할 것.
 *    (https://apiportal.koreainvestment.com > API 문서 > 해외주식)
 *    실전/모의 TR ID가 다르므로 mode에 따라 분기한다.
 *    문서 개정으로 ID가 바뀔 수 있어 이 파일 한 곳에만 모아둔다.
 */
import { config } from "../config.js";

const real = config.KIS_MODE === "real";

export const KIS = {
  // ===== OAuth =====
  token: { path: "/oauth2/tokenP" },
  wsApprovalKey: { path: "/oauth2/Approval" },

  // ===== 해외주식 시세 =====
  // 해외주식 현재체결가
  price: {
    path: "/uapi/overseas-price/v1/quotations/price",
    trId: "HHDFS00000300",
  },
  // 해외주식 기간별시세 (일/주/월)
  dailyChart: {
    path: "/uapi/overseas-price/v1/quotations/dailyprice",
    trId: "HHDFS76240000",
  },
  // 해외주식 분봉조회
  minuteChart: {
    path: "/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice",
    trId: "HHDFS76950200",
  },

  // ===== 해외주식 주문/계좌 =====
  // ✅ 공식 샘플(github.com/koreainvestment/open-trading-api) 대조 검증 완료
  // 미국 매수/매도 — 실전: TTTT1002U/TTTT1006U, 모의: VTTT1002U/VTTT1006U
  // ORD_DVSN: 매수 00(지정가)/32(LOO)/34(LOC), 매도 00/31(MOO)/32/33(MOC)/34
  // ⚠️ 모의투자는 00(지정가)만 지원 — 시장가 주문 불가
  orderBuy: {
    path: "/uapi/overseas-stock/v1/trading/order",
    trId: real ? "TTTT1002U" : "VTTT1002U",
  },
  orderSell: {
    path: "/uapi/overseas-stock/v1/trading/order",
    trId: real ? "TTTT1006U" : "VTTT1006U",
  },
  // 미국 주간거래(프리·애프터) 주문 — 실전 전용: TTTS6036U(매수)/TTTS6037U(매도)
  daytimeOrderBuy: {
    path: "/uapi/overseas-stock/v1/trading/daytime-order",
    trId: "TTTS6036U",
  },
  daytimeOrderSell: {
    path: "/uapi/overseas-stock/v1/trading/daytime-order",
    trId: "TTTS6037U",
  },
  // 주문 취소 — 실전: TTTT1004U, 모의: VTTT1004U ✅
  orderCancel: {
    path: "/uapi/overseas-stock/v1/trading/order-rvsecncl",
    trId: real ? "TTTT1004U" : "VTTT1004U",
  },
  // 미체결내역 — 실전/모의 동일: TTTS3018R ✅ (샘플 기준 V 버전 없음)
  openOrders: {
    path: "/uapi/overseas-stock/v1/trading/inquire-nccs",
    trId: "TTTS3018R",
  },
  // 잔고 — 실전: TTTS3012R, 모의: VTTS3012R ✅
  balance: {
    path: "/uapi/overseas-stock/v1/trading/inquire-balance",
    trId: real ? "TTTS3012R" : "VTTS3012R",
  },

  // ===== WebSocket 실시간 =====
  // 해외주식 실시간지연체결가 (미국)
  wsTrade: { trId: "HDFSCNT0" },
  // 해외주식 실시간지연호가 (미국)
  wsQuote: { trId: "HDFSASP0" },
} as const;

/** KIS 해외주식 API의 거래소 코드 매핑 (시세용/주문용이 다름에 주의) */
export const EXCH_CODE = {
  // 시세 API용 (EXCD)
  quote: { NAS: "NAS", NYS: "NYS", AMS: "AMS" },
  // 주문 API용 (OVRS_EXCG_CD)
  order: { NAS: "NASD", NYS: "NYSE", AMS: "AMEX" },
} as const;
