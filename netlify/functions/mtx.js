// 抓期交所「期貨每日交易行情」小台(MTX)資料，整理成連續近月日K
const URL = 'https://www.taifex.com.tw/cht/3/futDataDown';

const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

async function fetchRange(start, end) {
  const body = new URLSearchParams({
    down_type: '1', commodity_id: 'MTX', commodity_id2: '',
    queryStartDate: fmt(start), queryEndDate: fmt(end),
  });
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body,
  });
  if (!res.ok) throw new Error('期交所回應 ' + res.status);
  const buf = await res.arrayBuffer();
  return new TextDecoder('big5').decode(buf);
}

const num = s => { const v = parseFloat(String(s).replace(/,/g, '')); return isNaN(v) ? null : v; };

// 解析 CSV：交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,結算價,未沖銷契約數,...,交易時段
function parse(csv, session) {
  const rows = csv.split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
  const head = rows.find(r => r[0] && r[0].includes('交易日期'));
  if (!head) return [];
  const idx = name => head.findIndex(h => h.includes(name));
  const iDate = idx('交易日期'), iMon = idx('到期月份'), iO = idx('開盤'), iH = idx('最高'),
        iL = idx('最低'), iC = idx('收盤'), iV = idx('成交量'), iS = idx('交易時段');
  const out = [];
  for (const r of rows) {
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(r[iDate] || '')) continue;
    const mon = r[iMon] || '';
    if (!/^\d{6}$/.test(mon)) continue;                 // 只要月合約，排除週合約和價差
    if (iS >= 0 && session && !(r[iS] || '').includes(session)) continue;
    const o = num(r[iO]), h = num(r[iH]), l = num(r[iL]), c = num(r[iC]), v = num(r[iV]);
    if ([o, h, l, c].some(x => x === null)) continue;
    out.push({ date: r[iDate], mon, o, h, l, c, v: v || 0 });
  }
  return out;
}

// 每天取成交量最大的月合約（就是近月），組成連續日K
function continuous(rows) {
  const byDay = {};
  for (const r of rows) if (!byDay[r.date] || r.v > byDay[r.date].v) byDay[r.date] = r;
  return Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({ time: r.date.replace(/\//g, '-'), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, contract: r.mon }));
}

exports.handler = async (event) => {
  try {
    const months = Math.min(parseInt(event.queryStringParameters?.months || '24', 10) || 24, 60);
    const session = event.queryStringParameters?.session === 'night' ? '盤後' : '一般';
    const now = new Date(Date.now() + 8 * 3600e3); // 台灣時間
    const ranges = [];
    for (let i = 0; i < months; i++) {
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      ranges.push([start, end > now ? now : end]);
    }
    const all = [];
    // 一次 6 個請求，避免被期交所擋
    for (let i = 0; i < ranges.length; i += 6) {
      const parts = await Promise.all(ranges.slice(i, i + 6).map(([s, e]) => fetchRange(s, e).catch(() => '')));
      for (const p of parts) all.push(...parse(p, session));
    }
    const bars = continuous(all);
    if (!bars.length) throw new Error('期交所沒有回傳資料');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=600' },
      body: JSON.stringify({ updated: new Date().toISOString(), bars }),
    };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: e.message }) };
  }
};

exports._test = { parse, continuous };
