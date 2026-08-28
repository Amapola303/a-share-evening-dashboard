import { mkdir, readFile, writeFile } from "node:fs/promises";

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const targetDate = process.env.REVIEW_DATE || dateFmt.format(new Date());
const dataDir = new URL("../docs/data/", import.meta.url);
const headers = { "user-agent": "Mozilla/5.0 (compatible; AShareEveningDashboard/1.0)", referer: "https://data.eastmoney.com/" };
const n = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

async function getJson(url, requestHeaders = headers) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function shanghaiDateFromUnix(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? dateFmt.format(new Date(timestamp * 1000)) : null;
}

async function fetchIndices() {
  const fields = "f12,f13,f14,f2,f3,f6,f124";
  const secids = "1.000001,0.399001,0.399006,1.000688,1.000300";
  const payload = await getJson(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${secids}`);
  const rows = payload?.data?.diff || [];
  const indices = rows.map((row) => ({
    code: String(row.f12 || ""), name: String(row.f14 || ""), close: n(row.f2), pct: n(row.f3),
    amount: row.f6 == null ? null : Math.round(Number(row.f6) / 1e6) / 100,
  }));
  const sh = indices.find((item) => item.code === "000001")?.amount;
  const sz = indices.find((item) => item.code === "399001")?.amount;
  return { indices, quoteDate: rows.length ? shanghaiDateFromUnix(rows[0].f124) : null, turnover: sh != null && sz != null ? Math.round((sh + sz) * 100) / 100 : null };
}

async function limitPool(endpoint) {
  const sort = endpoint === "getTopicDTPool" ? "zdp:asc" : "fbt:asc";
  const date = targetDate.replaceAll("-", "");
  const url = `https://push2ex.eastmoney.com/${endpoint}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=${encodeURIComponent(sort)}&date=${date}`;
  const payload = await getJson(url, { "user-agent": headers["user-agent"], referer: "https://quote.eastmoney.com/ztb/detail" });
  if (Number(payload?.rc) !== 0 || !payload?.data) throw new Error(`${endpoint} unavailable`);
  const rows = payload.data.pool || [];
  const total = Number(payload.data.tc ?? rows.length);
  if (!Number.isFinite(total) || rows.length < total) throw new Error(`${endpoint} incomplete`);
  return total;
}

async function fetchBreadth() {
  const overviewUrl = "https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f104,f105,f124&secids=1.000001,0.399001";
  const [overview, limitUp, limitDown, broken] = await Promise.all([
    getJson(overviewUrl), limitPool("getTopicZTPool"), limitPool("getTopicDTPool"), limitPool("getTopicZBPool"),
  ]);
  const rows = overview?.data?.diff || [];
  if (rows.length !== 2) throw new Error("advance/decline overview incomplete");
  const up = rows.reduce((sum, row) => sum + Number(row.f104 || 0), 0);
  const down = rows.reduce((sum, row) => sum + Number(row.f105 || 0), 0);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up + down < 4000) throw new Error("advance/decline count abnormal");
  return { up, down, limitUp, limitDown, broken };
}

async function fetchFlow() {
  const url = "https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=1&pz=100&pn=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14,f62";
  const payload = await getJson(url);
  const rows = (payload?.data?.diff || []).map((row) => ({ name: String(row.f14 || ""), value: Math.round(Number(row.f62) / 1e6) / 100 })).filter((item) => Number.isFinite(item.value));
  rows.sort((a, b) => b.value - a.value);
  return { topIn: rows.filter((item) => item.value > 0).slice(0, 8), topOut: rows.filter((item) => item.value < 0).slice(-8).reverse(), source: "东方财富行业主力资金算法" };
}

async function emTable(reportName) {
  const filter = encodeURIComponent(`(TRADE_DATE>='${targetDate}')(TRADE_DATE<='${targetDate}')`);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=ALL&filter=${filter}&pageNumber=1&pageSize=500&source=WEB&client=WEB`;
  const payload = await getJson(url);
  return payload?.result?.data || [];
}

async function fetchLhb() {
  const [bill, buys, sells] = await Promise.all([
    emTable("RPT_DAILYBILLBOARD_DETAILS"), emTable("RPT_BILLBOARD_DAILYDETAILSBUY"), emTable("RPT_BILLBOARD_DAILYDETAILSSELL"),
  ]);
  if (!bill.length) return { status: "pending", billboardTotal: null, institutionTotal: null, buyCount: null, sellCount: null, dayNet: null, buy: [], sell: [] };
  const names = new Map();
  const meta = new Map();
  for (const row of bill) {
    const code = String(row.SECURITY_CODE || "");
    names.set(code, String(row.SECURITY_NAME_ABBR || code));
    if (!meta.has(code)) meta.set(code, { pct: n(row.CHANGE_RATE), turnover: n(row.TURNOVERRATE) });
  }
  const map = new Map();
  const touch = (row, side) => {
    if (row.OPERATEDEPT_NAME !== "机构专用") return;
    const code = String(row.SECURITY_CODE || "");
    if (/^(11|12)/.test(code)) return;
    const tradeId = String(row.TRADE_ID || "");
    const key = `${code}:${tradeId}`;
    const item = map.get(key) || { code, buy: 0, sell: 0, accum: Number(row.ACCUM_AMOUNT || 0), reason: String(row.EXPLANATION || "") };
    item[side] += Number(side === "buy" ? row.BUY : row.SELL) || 0;
    if (!item.reason) item.reason = String(row.EXPLANATION || "");
    map.set(key, item);
  };
  buys.forEach((row) => touch(row, "buy"));
  sells.forEach((row) => touch(row, "sell"));
  const dedup = new Map();
  for (const item of map.values()) {
    const netRaw = item.buy - item.sell;
    if (!netRaw) continue;
    const window = /连续[三3]个交易日/.test(item.reason) ? "3日" : "当日";
    const stockMeta = meta.get(item.code) || {};
    const row = {
      code: item.code, name: names.get(item.code) || item.code, pct: stockMeta.pct ?? null, turnover: stockMeta.turnover ?? null,
      instBuy: Math.round(item.buy / 100) / 100, instSell: Math.round(item.sell / 100) / 100,
      net: Math.round(netRaw / 100) / 100, ratio: item.accum ? Math.round(netRaw / item.accum * 10000) / 100 : null,
      window, reason: item.reason,
    };
    const key = `${item.code}:${window}`;
    if (!dedup.has(key) || Math.abs(row.net) > Math.abs(dedup.get(key).net)) dedup.set(key, row);
  }
  const all = [...dedup.values()];
  const buy = all.filter((item) => item.net > 0).sort((a, b) => b.net - a.net);
  const sell = all.filter((item) => item.net < 0).sort((a, b) => a.net - b.net);
  const dayNet = all.filter((item) => item.window === "当日").reduce((sum, item) => sum + item.net, 0) / 10000;
  const codes = new Set(bill.map((row) => String(row.SECURITY_CODE || "")).filter((code) => code && !/^(11|12)/.test(code)));
  return {
    status: "complete", billboardTotal: codes.size, institutionTotal: new Set(all.map((item) => item.code)).size,
    buyCount: new Set(buy.map((item) => item.code)).size, sellCount: new Set(sell.map((item) => item.code)).size,
    dayNet: Math.round(dayNet * 100) / 100, buy, sell,
  };
}

async function fetchMargin() {
  const filter = encodeURIComponent(`(DIM_DATE<='${targetDate}')`);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&filter=${filter}&pageNumber=1&pageSize=1&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB`;
  const payload = await getJson(url);
  const row = payload?.result?.data?.[0];
  if (!row) return { date: null, total: null, financing: null, lending: null };
  const financing = Number(row.RZYE) / 1e8;
  const lending = Number(row.RQYE) / 1e8;
  return { date: String(row.DIM_DATE || "").slice(0, 10), total: Math.round((financing + lending) * 100) / 100, financing: Math.round(financing * 100) / 100, lending: Math.round(lending * 100) / 100 };
}

async function collect() {
  const settled = await Promise.allSettled([fetchIndices(), fetchBreadth(), fetchFlow(), fetchMargin(), fetchLhb()]);
  const [indexResult, breadthResult, flowResult, marginResult, lhbResult] = settled;
  const gaps = [];
  const indices = indexResult.status === "fulfilled" ? indexResult.value : { indices: [], quoteDate: null, turnover: null };
  const breadth = breadthResult.status === "fulfilled" ? breadthResult.value : { up: null, down: null, limitUp: null, limitDown: null, broken: null };
  const flow = flowResult.status === "fulfilled" ? flowResult.value : { topIn: [], topOut: [], source: "待更新" };
  const margin = marginResult.status === "fulfilled" ? marginResult.value : { date: null, total: null, financing: null, lending: null };
  const lhb = lhbResult.status === "fulfilled" ? lhbResult.value : { status: "partial", billboardTotal: null, institutionTotal: null, buyCount: null, sellCount: null, dayNet: null, buy: [], sell: [] };
  if (indexResult.status === "rejected") gaps.push("指数与成交额接口暂不可用");
  if (breadthResult.status === "rejected") gaps.push("沪深涨跌家数或涨跌停池暂不可用");
  if (flowResult.status === "rejected") gaps.push("行业主力资金接口暂不可用");
  if (marginResult.status === "rejected") gaps.push("两融最近披露值暂不可用");
  if (lhbResult.status === "rejected") gaps.push("龙虎榜完整盘后表暂不可用");
  if (lhb.status === "pending") gaps.push("当日完整龙虎榜尚未披露，将在19:35再次抓取");
  if (margin.date !== targetDate) gaps.push(`两融为T+1披露，当前显示${margin.date || "最近可得"}数据`);
  return {
    date: targetDate, quoteDate: indices.quoteDate, updatedAt: new Date().toISOString(), status: gaps.length ? "partial" : "fresh",
    indices: indices.indices, turnover: indices.turnover, breadth, flow, margin, lhb, gaps,
    sources: ["东方财富盘后延迟行情节点", "东方财富涨跌停/炸板池", "东方财富交易公开信息", "东方财富两融历史"],
  };
}

await mkdir(dataDir, { recursive: true });
const snapshot = await collect();
if (snapshot.quoteDate !== targetDate) {
  console.log(`Skip ${targetDate}: latest quote date is ${snapshot.quoteDate || "unavailable"}.`);
  process.exit(0);
}
await writeFile(new URL(`${targetDate}.json`, dataDir), JSON.stringify(snapshot, null, 2) + "\n");
await writeFile(new URL("latest.json", dataDir), JSON.stringify(snapshot, null, 2) + "\n");
let history = [];
try { history = JSON.parse(await readFile(new URL("index.json", dataDir), "utf8")); } catch {}
const sh = snapshot.indices.find((item) => item.code === "000001");
const item = { date: targetDate, title: snapshot.lhb.status === "complete" ? "云端盘后资金面快照" : "盘后快照（部分数据待披露）", turnover: snapshot.turnover, shPct: sh?.pct ?? null, limitUp: snapshot.breadth.limitUp, updatedAt: snapshot.updatedAt };
history = [item, ...history.filter((old) => old.date !== targetDate)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120);
await writeFile(new URL("index.json", dataDir), JSON.stringify(history, null, 2) + "\n");
console.log(`Saved ${targetDate}: turnover=${snapshot.turnover}, LHB=${snapshot.lhb.status}.`);
