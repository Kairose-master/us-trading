import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";
import { kisKeys } from "../auth/credentials.js";
import { KIS, EXCH_CODE } from "./endpoints.js";
import { tokenManager } from "./auth.js";
import { RateLimiter } from "../core/rateLimiter.js";
import { logger } from "../core/logger.js";
import type { Exchange, Side, OrderType, Session } from "./types.js";

/**
 * KIS REST 어댑터. 프론트 스펙과 무관한 "원시" KIS 호출만 담당하고,
 * 응답 필드 매핑은 api/routes.ts 쪽 서비스 레이어에서 수행한다.
 *
 * ⚠️ 응답 필드명(output.last 등)은 KIS 공식 문서와 대조해 검증할 것.
 */
class KisClient {
  private http: AxiosInstance;
  readonly limiter = new RateLimiter(2, 4); // 보수적으로 2req/s (신규계정 제한 대응)

  constructor() {
    this.http = axios.create({ baseURL: config.kisBaseUrl, timeout: 10_000 });
  }

  private async headers(trId: string) {
    const token = await tokenManager.get();
    return {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: (kisKeys()?.appKey ?? ""),
      appsecret: (kisKeys()?.appSecret ?? ""),
      tr_id: trId,
      custtype: "P", // 개인
    };
  }

  private async get(pathTrId: { path: string; trId: string }, params: Record<string, string>) {
    await this.limiter.acquire();
    const res = await this.http.get(pathTrId.path, {
      headers: await this.headers(pathTrId.trId),
      params,
    });
    if (res.data.rt_cd !== "0") {
      logger.warn("KIS GET non-zero rt_cd", { path: pathTrId.path, msg: res.data.msg1 });
      throw new Error(res.data.msg1 ?? "KIS API error");
    }
    return res.data;
  }

  private async post(pathTrId: { path: string; trId: string }, body: Record<string, string>) {
    await this.limiter.acquire();
    const res = await this.http.post(pathTrId.path, body, {
      headers: await this.headers(pathTrId.trId),
    });
    if (res.data.rt_cd !== "0") {
      logger.warn("KIS POST non-zero rt_cd", { path: pathTrId.path, msg: res.data.msg1 });
      throw new Error(res.data.msg1 ?? "KIS API error");
    }
    return res.data;
  }

  // ===== 시세 =====

  async price(symbol: string, exch: Exchange) {
    const data = await this.get(KIS.price, {
      AUTH: "",
      EXCD: EXCH_CODE.quote[exch],
      SYMB: symbol,
    });
    return data.output; // { last, base(전일종가), pvol, diff, rate, ... } — 문서 대조 필요
  }

  async dailyChart(symbol: string, exch: Exchange, count = 120) {
    const data = await this.get(KIS.dailyChart, {
      AUTH: "",
      EXCD: EXCH_CODE.quote[exch],
      SYMB: symbol,
      GUBN: "0", // 0: 일
      BYMD: "", // 공백: 최근부터
      MODP: "1", // 수정주가
    });
    return (data.output2 ?? []).slice(0, count);
  }

  // ===== 주문 =====

  async placeOrder(p: {
    symbol: string;
    exch: Exchange;
    side: Side;
    orderType: OrderType;
    qty: number;
    price?: number;
    session: Session;
  }) {
    // ✅ 검증됨: 모의투자는 지정가(00)만 지원. 미국 정규장 매수는 순수 시장가 미지원(LOO/LOC만).
    if (p.orderType === "market") {
      if (config.KIS_MODE !== "real") {
        throw new Error("모의투자는 지정가 주문만 지원 — 가격을 지정하세요");
      }
      if (p.side === "buy") {
        throw new Error("미국 매수는 시장가 미지원(지정가/LOO/LOC) — 지정가로 주문하세요");
      }
    }
    if (!p.price || p.price <= 0) {
      throw new Error("지정가 주문 가격 필요");
    }
    // 프리·애프터는 주간거래 전용 TR (실전 전용)
    const extended = p.session === "extended";
    if (extended && config.KIS_MODE !== "real") {
      throw new Error("모의투자는 프리·애프터마켓 주문 미지원");
    }
    const ep = extended
      ? p.side === "buy"
        ? KIS.daytimeOrderBuy
        : KIS.daytimeOrderSell
      : p.side === "buy"
        ? KIS.orderBuy
        : KIS.orderSell;
    const ordDvsn = "00"; // 지정가
    const data = await this.post(ep, {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      OVRS_EXCG_CD: EXCH_CODE.order[p.exch],
      PDNO: p.symbol,
      ORD_QTY: String(p.qty),
      OVRS_ORD_UNPR: String(p.price),
      ORD_SVR_DVSN_CD: "0",
      ORD_DVSN: ordDvsn,
    });
    return data.output; // { KRX_FWDG_ORD_ORGNO, ODNO(주문번호), ORD_TMD }
  }

  async cancelOrder(p: { symbol: string; exch: Exchange; orderId: string; qty: number }) {
    const data = await this.post(KIS.orderCancel, {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      OVRS_EXCG_CD: EXCH_CODE.order[p.exch],
      PDNO: p.symbol,
      ORGN_ODNO: p.orderId,
      RVSE_CNCL_DVSN_CD: "02", // 02: 취소
      ORD_QTY: String(p.qty),
      OVRS_ORD_UNPR: "0",
    });
    return data.output;
  }

  async openOrders() {
    const data = await this.get(KIS.openOrders, {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      OVRS_EXCG_CD: "NASD", // 미국 전체 조회 시 NASD로 조회 가능 여부 문서 확인
      SORT_SQN: "DS",
      CTX_AREA_FK200: "",
      CTX_AREA_NK200: "",
    });
    return data.output ?? [];
  }

  async balance() {
    const data = await this.get(KIS.balance, {
      CANO: config.cano,
      ACNT_PRDT_CD: config.acntPrdtCd,
      OVRS_EXCG_CD: "NASD",
      TR_CRCY_CD: "USD",
      CTX_AREA_FK200: "",
      CTX_AREA_NK200: "",
    });
    return { positions: data.output1 ?? [], summary: data.output2 ?? {} };
  }
}

export const kisClient = new KisClient();
