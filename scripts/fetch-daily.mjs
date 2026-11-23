// 下載期交所「期貨每日交易行情」小台(MTX)，整理成日K，存成 data/daily.json
// 四條：近月／次月 × 只算日盤／含夜盤。第一次抓 5 年，之後只重抓最近 2 個月
// 由 GitHub Actions 每天自動跑（.github/workflows/fetch-ticks.yml）
import fs from 'node:fs';

const OUT = 'data/daily.json', RAW = 'data/daily-rows.json'; // RAW：原始每一列（合併用，網頁不讀）
const URL = 'https://www.taifex.com.tw/cht/3/futDataDown';
const YEARS = +process.env.YEARS || 5;
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

async function fetchRange(start, end) {
  const body = new URLSearchParams({ down_type: '1', commodity_id: 'MTX', commodity_id2: '', queryStartDate: fmt(start), queryEndDate: fmt(end) });
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, body });
      if (r.ok) return new TextDecoder('big5').decode(await r.arrayBuffer());
    } catch {}
    await sleep(2000);
  }
  return '';
}

// 交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,...,交易時段
export function parse(csv) {
  const rows = csv.split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
  const head = rows.find(r => r[0] && r[0].includes('交易日期'));
  if (!head) return [];
  const ix = n => head.findIndex(h => h.includes(n));
  const iD = ix('交易日期'), iM = ix('到期月份'), iO = ix('開盤'), iH = ix('最高'), iL = ix('最低'), iC = ix('收盤'), iV = ix('成交量'), iS = ix('交易時段');
  const out = [];
  for (const r of rows) {
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(r[iD] || '')) continue;
    const k = r[iM] || ''; if (!/^\d{6}$/.test(k)) continue;
    const o = num(r[iO]), h = num(r[iH]), l = num(r[iL]), c = num(r[iC]);
    if (![o, h, l, c].every(x => x > 0)) continue;
    out.push({ d: r[iD].replace(/\//g, '-'), k, o, h, l, c, v: num(r[iV]) || 0, night: (r[iS] || '').includes('盤後') });
  }
  return out;
}

// rows → 四條日K。夜盤：期交所把「前一晚的夜盤」列在隔天的交易日期底下（跟每筆成交檔一樣）
export function build(rows) {
  const byD = new Map();
  for (const r of rows) { if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(r); }
  const res = { near_day: [], near_all: [], next_day: [], next_all: [] };
  for (const d of [...byD.keys()].sort()) {
    const list = byD.get(d), day = list.filter(r => !r.night).sort((a, b) => a.k.localeCompare(b.k));
    [['near', day[0]], ['next', day[1]]].forEach(([w, D]) => {
      if (!D) return;
      res[w + '_day'].push([d, D.o, D.h, D.l, D.c, D.v, D.k]);
      const N = list.find(r => r.night && r.k === D.k);
      res[w + '_all'].push(N ? [d, N.o, Math.max(D.h, N.h), Math.min(D.l, N.l), D.c, D.v + N.v, D.k] : [d, D.o, D.h, D.l, D.c, D.v, D.k]);
    });
  }
  return res;
}

async function main() {
  const old = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, 'utf8')) : null;
  const now = new Date(Date.now() + 8 * 3600e3);
  const months = old?.rows?.length ? 2 : YEARS * 12;
  let rows = [];
  for (let i = 0; i < months; i++) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
    const got = parse(await fetchRange(start, end > now ? now : end));
    console.log(fmt(start).slice(0, 7), got.length, '筆');
    rows.push(...got);
    await sleep(400);
  }
  if (!rows.length) { console.log('期交所沒有回傳資料，保留舊檔'); return; }
  if (old?.rows) { // 合併：新抓的那幾天蓋掉舊的
    const newD = new Set(rows.map(r => r.d));
    rows = old.rows.filter(r => !newD.has(r.d)).concat(rows);
  }
  rows.sort((a, b) => a.d.localeCompare(b.d) || a.k.localeCompare(b.k));
  const series = build(rows);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), ...series }));
  fs.writeFileSync(RAW, JSON.stringify({ rows }));
  console.log(`完成：${series.near_day[0]?.[0]} ～ ${series.near_day.at(-1)?.[0]}，${series.near_day.length} 天`);

  // 檢查夜盤日期對不對：用最新一天的 1 分K 檔算夜盤開高低，跟日K的夜盤那列比
  const last = series.near_day.at(-1)?.[0], f = `data/1m/${last}.json`;
  if (fs.existsSync(f)) {
    const b = JSON.parse(fs.readFileSync(f, 'utf8')).near?.bars || [], n = b.filter(x => { const m = (x[0] % 86400) / 60; return m >= 900 || m < 360; });
    const N = rows.find(r => r.d === last && r.night && r.k === series.near_day.at(-1)[6]);
    if (n.length && N) console.log('夜盤核對', last, '1分K:', n[0][1], Math.max(...n.map(x => x[2])), Math.min(...n.map(x => x[3])), n.at(-1)[4], '｜日K夜盤列:', N.o, N.h, N.l, N.c);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
