import { mkdir, readFile, writeFile } from "node:fs/promises";

const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const targetDate = process.env.REVIEW_DATE || dateFmt.format(new Date());
const dataDir = new URL("../docs/data/", import.meta.url);
const headers = {
  "user-agent": "Mozilla/5.0 (compatible; AShareEveningDashboard/2.1)",
  referer: "https://data.eastmoney.com/",
  "cache-control": "no-cache",
  pragma: "no-cache",
};
const n = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits));

async function getJson(url, requestHeaders = headers) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    }
  }
  throw lastError;
}

async function getText(url, requestHeaders = headers) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
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
    amount: row.f6 == null ? null : round(Number(row.f6) / 1e8),
  }));
  const sh = indices.find((item) => item.code === "000001")?.amount;
  const sz = indices.find((item) => item.code === "399001")?.amount;
  return { indices, quoteDate: rows.length ? shanghaiDateFromUnix(rows[0].f124) : null, turnover: sh != null && sz != null ? round(sh + sz) : null };
}

async function fetchTencentVerification() {
  const text = await getText("https://qt.gtimg.cn/q=sh000001,sz399001,sz399006,sh000688,sh000300", { "user-agent": headers["user-agent"], referer: "https://gu.qq.com/" });
  const rows = [];
  for (const line of text.split(";")) {
    const match = line.match(/v_(?:sh|sz)(\d+)="([\s\S]*?)"/);
    if (!match) continue;
    const fields = match[2].split("~");
    rows.push({ code: match[1], close: n(fields[3]), pct: n(fields[32]), amount: fields[37] == null ? null : round(Number(fields[37]) / 10000) });
  }
  if (rows.length < 5) throw new Error("Tencent quote response incomplete");
  return rows;
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
  return { total, rows };
}

async function fetchBreadth() {
  const overviewUrl = "https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f104,f105,f124&secids=1.000001,0.399001";
  // Keep these requests sequential. The public endpoint is noticeably less stable
  // when four pool queries arrive at the same instant from one cloud runner.
  const overview = await getJson(overviewUrl);
  const limitUp = await limitPool("getTopicZTPool");
  const limitDown = await limitPool("getTopicDTPool");
  const broken = await limitPool("getTopicZBPool");
  const rows = overview?.data?.diff || [];
  if (rows.length !== 2) throw new Error("advance/decline overview incomplete");
  const up = rows.reduce((sum, row) => sum + Number(row.f104 || 0), 0);
  const down = rows.reduce((sum, row) => sum + Number(row.f105 || 0), 0);
  if (!Number.isFinite(up) || !Number.isFinite(down) || up + down < 4000) throw new Error("advance/decline count abnormal");
  const ladderRows = limitUp.rows.map((row) => ({
    code: String(row.c ?? row.code ?? ""),
    name: String(row.n ?? row.name ?? "—"),
    board: n(row.lbc ?? row.zttj?.ct) ?? 1,
    theme: String(row.hybk ?? row.yyb ?? "—"),
  })).filter((row) => row.board >= 2).sort((a, b) => b.board - a.board || a.code.localeCompare(b.code));
  return {
    breadth: {
      up, down, limitUp: limitUp.total, limitUpAll: limitUp.total, limitDown: limitDown.total, limitDownAll: limitDown.total,
      broken: broken.total, brokenRate: round(broken.total / Math.max(1, limitUp.total + broken.total) * 100),
      newHigh: null, newLow: null, newHighRows: [],
    },
    ladder: {
      status: ladderRows.length ? "provisional" : "pending",
      maxBoard: ladderRows.length ? Math.max(...ladderRows.map((row) => row.board)) : null,
      rows: ladderRows,
      source: "东方财富涨停池盘后连板字段；在线快照口径，完整报告仍需严格K线逐只复核",
    },
  };
}

async function flowRows(fs, po) {
  const url = `https://push2delay.eastmoney.com/api/qt/clist/get?fid=f62&po=${po}&pz=80&pn=1&np=1&fltt=2&invt=2&fs=${encodeURIComponent(fs)}&fields=f12,f14,f62`;
  const payload = await getJson(url);
  return (payload?.data?.diff || []).map((row) => ({ name: String(row.f14 || ""), value: round(Number(row.f62) / 1e8) })).filter((item) => item.name && item.value != null);
}

async function fetchFlow() {
  const stockScope = "m:0+t:6,m:0+t:13,m:0+t:80,m:1+t:2,m:1+t:23";
  const [industryIn, industryOut, stockIn, stockOut] = await Promise.all([
    flowRows("m:90+t:2", 1), flowRows("m:90+t:2", 0), flowRows(stockScope, 1), flowRows(stockScope, 0),
  ]);
  const take = (rows, positive) => rows.filter((row) => positive ? row.value > 0 : row.value < 0).slice(0, 8);
  return {
    groups: [
      { title: "行业主力 · 净流入", rows: take(industryIn, true) },
      { title: "行业主力 · 净流出", rows: take(industryOut, false) },
      { title: "个股主力 · 净流入", rows: take(stockIn, true) },
      { title: "个股主力 · 净流出", rows: take(stockOut, false) },
    ],
    source: "东方财富主力资金算法",
    scope: "平台算法口径，行业与个股绝对额不可与其他平台直接相加",
  };
}

async function emTable(reportName) {
  const filter = encodeURIComponent(`(TRADE_DATE>='${targetDate}')(TRADE_DATE<='${targetDate}')`);
  const rows = [];
  const pageSize = 500;
  let expected = null;
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=${reportName}&columns=ALL&filter=${filter}&pageNumber=${pageNumber}&pageSize=${pageSize}&source=WEB&client=WEB`;
    const payload = await getJson(url);
    const result = payload?.result;
    if (!result) return rows;
    const pageRows = result.data || [];
    if (expected == null) expected = Number(result.count ?? pageRows.length);
    rows.push(...pageRows);
    const pages = Number(result.pages ?? Math.ceil((expected || 0) / pageSize));
    if (pageNumber >= pages || pageRows.length < pageSize) break;
  }
  if (Number.isFinite(expected) && rows.length < expected) {
    throw new Error(`${reportName} incomplete: ${rows.length}/${expected}`);
  }
  return rows;
}

async function fetchLhb() {
  // Fetch sequentially to reduce throttling; buy/sell tables can exceed 500 rows.
  const bill = await emTable("RPT_DAILYBILLBOARD_DETAILS");
  if (!bill.length) return { status: "pending", billboardTotal: null, institutionTotal: null, buyCount: null, sellCount: null, dayNet: null, buy: [], sell: [], scope: "完整盘后表待披露，未沿用前一交易日" };
  const buys = await emTable("RPT_BILLBOARD_DAILYDETAILSBUY");
  const sells = await emTable("RPT_BILLBOARD_DAILYDETAILSSELL");
  if (!buys.length || !sells.length) throw new Error("LHB institution-side tables incomplete");
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
      instBuy: round(item.buy / 1e4), instSell: round(item.sell / 1e4), net: round(netRaw / 1e4),
      ratio: item.accum ? round(netRaw / item.accum * 100) : null, window, reason: item.reason,
    };
    const key = `${item.code}:${window}`;
    if (!dedup.has(key) || Math.abs(row.net) > Math.abs(dedup.get(key).net)) dedup.set(key, row);
  }
  const all = [...dedup.values()];
  const buy = all.filter((item) => item.net > 0).sort((a, b) => b.net - a.net);
  const sell = all.filter((item) => item.net < 0).sort((a, b) => a.net - b.net);
  const dayNet = all.filter((item) => item.window === "当日").reduce((sum, item) => sum + item.net, 0) / 10000;
  const codes = new Set(bill.map((row) => String(row.SECURITY_CODE || "")).filter((code) => code && !/^(11|12)/.test(code)));
  const dayRows = all.filter((item) => item.window === "当日");
  return {
    status: "complete", billboardTotal: codes.size, institutionTotal: new Set(all.map((item) => item.code)).size,
    buyCount: new Set(dayRows.filter((item) => item.net > 0).map((item) => item.code)).size,
    sellCount: new Set(dayRows.filter((item) => item.net < 0).map((item) => item.code)).size,
    dayNet: round(dayNet), buy, sell,
    scope: "东方财富交易公开信息完整分页表；机构现身按证券与当日/3日窗口去重，净买/净卖家数及净额只统计当日窗口并剔除可转债",
  };
}

async function fetchMargin() {
  const filter = encodeURIComponent(`(DIM_DATE<='${targetDate}')`);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&filter=${filter}&pageNumber=1&pageSize=2&sortColumns=DIM_DATE&sortTypes=-1&source=WEB&client=WEB`;
  const payload = await getJson(url);
  const rows = payload?.result?.data || [];
  if (!rows.length) return { date: null, total: null, financing: null, lending: null, change: null };
  const parsed = rows.map((row) => {
    const financing = Number(row.RZYE) / 1e8;
    const lending = Number(row.RQYE) / 1e8;
    return { date: String(row.DIM_DATE || "").slice(0, 10), total: round(financing + lending), financing: round(financing), lending: round(lending) };
  });
  return { ...parsed[0], change: parsed[1]?.total == null ? null : round(parsed[0].total - parsed[1].total) };
}

async function fetchEtf(previous) {
  const definitions = [
    ["510300", "沪深300ETF", "1.510300"], ["510500", "中证500ETF", "1.510500"], ["512100", "中证1000ETF", "1.512100"],
    ["588000", "科创50ETF", "1.588000"], ["159915", "创业板ETF", "0.159915"],
  ];
  const secids = definitions.map((item) => item[2]).join(",");
  const payload = await getJson(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f6,f124&secids=${secids}`);
  const quotes = new Map((payload?.data?.diff || []).map((row) => [String(row.f12), row]));
  const oldRows = new Map((previous?.rows || []).map((row) => [row.code, row]));
  return {
    rows: definitions.map(([code, name]) => {
      const row = quotes.get(code) || {};
      const old = oldRows.get(code) || {};
      return {
        code, name, close: n(row.f2), pct: n(row.f3), amount: row.f6 == null ? null : round(Number(row.f6) / 1e8),
        shareLatest: old.shareLatest ?? null, shareDate: old.shareDate ?? "待披露", shareWow: old.shareWow ?? null, shareMom: old.shareMom ?? null,
      };
    }),
    shareSeries: previous?.shareSeries ?? {},
    asOf: `成交额 ${targetDate}；份额按各行最近可得日期`,
    source: "东方财富盘后ETF行情；份额无稳定公开T+1接口时保留最近可得值并标注日期",
  };
}

function appendSeries(series, date, fields) {
  const current = structuredClone(series || { dates: [] });
  current.dates ||= [];
  let index = current.dates.indexOf(date);
  if (index < 0) { current.dates.push(date); index = current.dates.length - 1; }
  for (const [key, value] of Object.entries(fields)) {
    current[key] ||= [];
    while (current[key].length < current.dates.length) current[key].push(null);
    current[key][index] = value;
  }
  if (current.dates.length > 30) {
    const cut = current.dates.length - 30;
    current.dates = current.dates.slice(cut);
    for (const key of Object.keys(fields)) current[key] = current[key].slice(cut);
  }
  return current;
}

function carryMacro(previous) {
  if (previous?.dr007 || previous?.y10 || previous?.omo) return { ...previous, source: `${previous.source || "最近可得公开数据"}；本次自动任务未取得稳定公开增量，保留原日期` };
  return {
    dr007: { date: null, value: null }, y10: { date: null, value: null }, omo: { date: null, inject: null, mature: null, net: null },
    series: { dr007: { dates: [], v: [] }, y10: { dates: [], v: [] }, omo: { dates: [], inject: [], mature: [] } },
    asOf: null, source: "公开稳定接口暂缺，等待权威盘后数据补录",
  };
}

function buildOutlook(snapshot) {
  const topFlow = snapshot.flow.groups?.find((group) => /行业主力.*净流入/.test(group.title))?.rows?.[0];
  const maxBoard = snapshot.ladder.maxBoard;
  const turnoverText = snapshot.turnover == null ? "成交额待补" : `沪深成交${Math.round(snapshot.turnover)}亿元`;
  return {
    date: targetDate,
    next_trade_date: null,
    mode: "规则化情景观察，不是收益预测",
    signals: [
      { tag: "量能", title: "成交能否支持指数延续？", watch: `${turnoverText}，观察次日量价是否同向。`, scenarios: [
        { label: "放量共振", desc: "成交放大且主要指数同步走强。", tone: "up" },
        { label: "缩量震荡", desc: "成交收缩，指数维持区间运行。", tone: "flat" },
        { label: "量价背离", desc: "放量滞涨或缩量下行，风险偏好回落。", tone: "down" },
      ] },
      { tag: "情绪", title: "高标与连板梯队如何反馈？", watch: maxBoard == null ? "连板梯队待盘后完整数据。" : `最高${maxBoard}连板，观察高标晋级与炸板率。`, scenarios: [
        { label: "梯队加强", desc: "高标晋级且中位连板扩容。", tone: "up" },
        { label: "温和分化", desc: "高标保留、低位淘汰。", tone: "flat" },
        { label: "高度退潮", desc: "高标集中断板且炸板率上升。", tone: "down" },
      ] },
      { tag: "资金", title: "主力方向能否持续？", watch: topFlow ? `当前行业净流入居前：${topFlow.name}。` : "行业主力资金方向待更新。", scenarios: [
        { label: "方向延续", desc: "领涨方向继续获得增量资金。", tone: "up" },
        { label: "内部轮动", desc: "主线仍在但细分方向切换。", tone: "flat" },
        { label: "集中兑现", desc: "核心方向转为明显净流出。", tone: "down" },
      ] },
      { tag: "流动性", title: "杠杆与短端资金是否平稳？", watch: `两融显示${snapshot.margin.date || "最近可得"}，宏观利率按各自披露日。`, scenarios: [
        { label: "边际改善", desc: "两融回升且短端利率平稳。", tone: "up" },
        { label: "维持平衡", desc: "杠杆与资金价格变化有限。", tone: "flat" },
        { label: "边际收紧", desc: "两融下降且短端资金价格上行。", tone: "down" },
      ] },
    ],
  };
}

function automaticNarrative(snapshot) {
  const sh = snapshot.indices.find((item) => item.code === "000001");
  const top = snapshot.flow.groups?.find((group) => /行业主力.*净流入/.test(group.title))?.rows?.[0]?.name;
  return {
    title: `${targetDate} A股资金面复盘`,
    subtitle: "云端盘后自动更新 · 八模块完整看板",
    conclusion: `沪指${sh?.pct == null ? "待更新" : `${sh.pct >= 0 ? "+" : ""}${sh.pct.toFixed(2)}%`}，沪深成交${snapshot.turnover == null ? "待更新" : `${snapshot.turnover.toFixed(2)}亿元`}；${top ? `${top}行业主力净流入居前` : "主力资金方向待补"}。龙虎榜、两融与宏观数据按各自真实披露日展示。`,
    notes: {
      s1: "指数收盘与成交额采用盘后延迟行情，并用腾讯行情作独立复核。",
      s2: "涨跌停与炸板采用公开涨停池口径；云端连板为盘后池初筛，完整日报需严格K线逐只复核。",
      s3: "两融为T+1披露，页面显示真实数据日期。",
      s4: "主力资金为平台算法，不同平台绝对额不可直接相加。",
      s5: "机构席位按证券与当日/3日窗口去重，净额只统计当日窗口。",
      s6: "ETF成交额为当日；份额缺少稳定公开增量时保留最近可得日期。",
      s7: "宏观数据未取得稳定公开增量时保留最近可得日期，不冒充当日。",
      s8: "次日情景为规则化观察框架，不是价格或收益预测。",
    },
    foot: "行情与盘后统计来自公开数据接口。缺失项显示为—或最近可得日期，不猜测、不以0代替。内容仅供研究，不构成投资建议。",
  };
}

async function collect(previous) {
  const settled = await Promise.allSettled([fetchIndices(), fetchTencentVerification(), fetchBreadth(), fetchFlow(), fetchMargin(), fetchLhb(), fetchEtf(previous?.etf)]);
  const [indexResult, verifyResult, breadthResult, flowResult, marginResult, lhbResult, etfResult] = settled;
  const gaps = [];
  const indices = indexResult.status === "fulfilled" ? indexResult.value : { indices: [], quoteDate: null, turnover: null };
  const sameDayPrevious = previous?.date === targetDate ? previous : null;
  const breadthData = breadthResult.status === "fulfilled" ? breadthResult.value : sameDayPrevious ? {
    breadth: sameDayPrevious.breadth,
    ladder: sameDayPrevious.ladder,
  } : {
    breadth: { up: null, down: null, limitUp: null, limitUpAll: null, limitDown: null, limitDownAll: null, broken: null, brokenRate: null, newHigh: null, newLow: null, newHighRows: [] },
    ladder: { status: "pending", maxBoard: null, rows: [], source: "接口暂不可用" },
  };
  const flow = flowResult.status === "fulfilled" ? flowResult.value : sameDayPrevious?.flow ?? { groups: [], source: "待更新", scope: "接口暂不可用" };
  const margin = marginResult.status === "fulfilled" ? marginResult.value : sameDayPrevious?.margin ?? { date: null, total: null, financing: null, lending: null, change: null };
  const fetchedLhb = lhbResult.status === "fulfilled" ? lhbResult.value : null;
  const lhb = fetchedLhb?.status === "pending" && sameDayPrevious?.lhb?.status === "complete"
    ? { ...sameDayPrevious.lhb, scope: `${sameDayPrevious.lhb.scope}；本次接口返回空，保留同交易日已核验完整表` }
    : fetchedLhb ?? sameDayPrevious?.lhb ?? { status: "partial", billboardTotal: null, institutionTotal: null, buyCount: null, sellCount: null, dayNet: null, buy: [], sell: [], scope: "接口暂不可用" };
  const etf = etfResult.status === "fulfilled" ? etfResult.value : previous?.etf ?? { rows: [], shareSeries: {}, asOf: null, source: "接口暂不可用" };
  const macro = carryMacro(previous?.macro);
  if (indexResult.status === "rejected") gaps.push("指数与成交额接口暂不可用");
  if (verifyResult.status === "rejected") gaps.push("腾讯行情二次核验接口暂不可用");
  if (breadthResult.status === "rejected") gaps.push("沪深涨跌家数、涨跌停池或连板初筛暂不可用");
  if (flowResult.status === "rejected") gaps.push("行业/个股主力资金接口暂不可用");
  if (marginResult.status === "rejected") gaps.push("两融最近披露值暂不可用");
  if (lhbResult.status === "rejected") gaps.push("龙虎榜完整盘后表暂不可用");
  if (etfResult.status === "rejected") gaps.push("ETF当日成交行情暂不可用，保留最近可得数据");
  if (lhb.status === "pending") gaps.push("当日完整龙虎榜尚未披露，将在后续17:30或19:00刷新继续抓取");
  if (margin.date !== targetDate) gaps.push(`两融为T+1披露，当前显示${margin.date || "最近可得"}数据`);
  if (breadthData.breadth.newHigh == null) gaps.push("历史新高/新低需全市场K线计算，云端快速版当前待补");
  if (macro.asOf !== targetDate) gaps.push(`宏观流动性显示${macro.asOf || "最近可得"}数据，未冒充当日`);
  const snapshot = {
    date: targetDate, quoteDate: indices.quoteDate, updatedAt: new Date().toISOString(), status: gaps.length ? "partial" : "fresh",
    indices: indices.indices, turnover: indices.turnover, breadth: breadthData.breadth, ladder: breadthData.ladder,
    flow, margin, lhb, etf, macro, gaps,
    trends: {
      turnover: appendSeries(previous?.trends?.turnover, targetDate, { total: indices.turnover }),
      breadth: appendSeries(previous?.trends?.breadth, targetDate, { up_limit: breadthData.breadth.limitUp, down_limit: breadthData.breadth.limitDown, broken: breadthData.breadth.broken, new_high: breadthData.breadth.newHigh, new_low: breadthData.breadth.newLow }),
      margin: appendSeries(previous?.trends?.margin, margin.date || targetDate, { rzye: margin.financing, rqye: margin.lending }),
      lhb: appendSeries(previous?.trends?.lhb, targetDate, { v: lhb.dayNet }),
    },
    verification: {
      status: verifyResult.status === "fulfilled" ? "two_source_index_check_completed" : "secondary_index_source_unavailable",
      checks: {
        indexPrimary: "东方财富盘后延迟行情",
        indexSecondary: verifyResult.status === "fulfilled" ? "腾讯行情已取得；差异由页面核验提示保留" : "腾讯行情暂不可用",
        lhb: "东方财富交易公开信息三表；机构席位按证券与窗口去重",
        disclosure: "两融、ETF份额和宏观数据分别标注真实as-of日期",
      },
    },
    sources: [
      "东方财富盘后延迟行情、涨跌停池、主力资金、两融与交易公开信息",
      "腾讯行情（指数二次核验）",
      "最近可得的人民银行/资金利率/债券收益率核验数据（宏观模块按真实日期保留）",
    ],
  };
  snapshot.outlook = buildOutlook(snapshot);
  snapshot.narrative = automaticNarrative(snapshot);
  snapshot.summary = [
    { label: "上证指数", value: snapshot.indices.find((item) => item.code === "000001")?.close ?? null, sub: snapshot.indices.find((item) => item.code === "000001")?.pct ?? null, tone: "market" },
    { label: "沪深成交", value: snapshot.turnover, sub: "亿元", tone: "flat" },
    { label: "涨停 / 跌停", value: `${snapshot.breadth.limitUp ?? "—"} / ${snapshot.breadth.limitDown ?? "—"}`, sub: `炸板${snapshot.breadth.broken ?? "—"}家`, tone: "flat" },
    { label: "最高板", value: snapshot.ladder.maxBoard == null ? "—" : `${snapshot.ladder.maxBoard}连板`, sub: `${snapshot.ladder.rows.length}只连板初筛`, tone: "flat" },
    { label: "两融余额", value: snapshot.margin.total, sub: snapshot.margin.date || "待披露", tone: "flat" },
    { label: "龙虎榜机构", value: snapshot.lhb.dayNet, sub: "亿元·当日窗口", tone: "market" },
  ];
  if (snapshot.indices.length < 5 || snapshot.turnover == null || snapshot.turnover <= 0) {
    throw new Error("Snapshot validation failed: index or turnover data incomplete");
  }
  if (snapshot.lhb.status === "complete" && (!Array.isArray(snapshot.lhb.buy) || !Array.isArray(snapshot.lhb.sell))) {
    throw new Error("Snapshot validation failed: LHB detail arrays missing");
  }
  return snapshot;
}

await mkdir(dataDir, { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile(new URL("latest.json", dataDir), "utf8")); } catch {}
const snapshot = await collect(previous);
if (snapshot.quoteDate !== targetDate) {
  console.log(`Skip ${targetDate}: latest quote date is ${snapshot.quoteDate || "unavailable"}.`);
  process.exit(0);
}
await writeFile(new URL(`${targetDate}.json`, dataDir), JSON.stringify(snapshot, null, 2) + "\n");
await writeFile(new URL("latest.json", dataDir), JSON.stringify(snapshot, null, 2) + "\n");
let history = [];
try { history = JSON.parse(await readFile(new URL("index.json", dataDir), "utf8")); } catch {}
const sh = snapshot.indices.find((item) => item.code === "000001");
const item = { date: targetDate, title: snapshot.narrative.title, turnover: snapshot.turnover, shPct: sh?.pct ?? null, limitUp: snapshot.breadth.limitUp, updatedAt: snapshot.updatedAt };
history = [item, ...history.filter((old) => old.date !== targetDate)].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120);
await writeFile(new URL("index.json", dataDir), JSON.stringify(history, null, 2) + "\n");
console.log(`Saved ${targetDate}: turnover=${snapshot.turnover}, LHB=${snapshot.lhb.status}, modules=8.`);
