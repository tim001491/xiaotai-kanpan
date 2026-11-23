// 小台即時報價中繼站：網頁 → 這支 Netlify Function → 期交所 MIS 行情網站
// 網址：/api/mxf?a=quote        取近月小台報價（自動判斷日盤／夜盤）
//       /api/mxf?a=quote&mt=0   強制日盤（mt=1 夜盤）
//       /api/mxf?a=raw          原始資料（除錯用，貼給 Claude 看）
//       （日／週／月K 由 /api/mtx 直接抓期交所，不在這支）
//       /api/mxf?a=hist&sym=XXX 嘗試取當日 1 分 K（期交所格式不確定，抓不到就略過）
const BASE = 'https://mis.taifex.com.tw/futures/api/';
const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://mis.taifex.com.tw',
  'Referer': 'https://mis.taifex.com.tw/futures/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
};

const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '')); return Number.isFinite(v) ? v : NaN; };
const json = (obj, status = 200, cdn) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(cdn ? { 'Netlify-CDN-Cache-Control': cdn } : {}) }
});

// 台灣時間 08:30～14:50 視為日盤（一般交易時段），其他時間看夜盤（盤後交易時段）
function autoSession() {
  const d = new Date(Date.now() + 8 * 3600e3), t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return t >= 8 * 60 + 30 && t < 14 * 60 + 50 ? '0' : '1';
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`期交所回應 HTTP ${r.status}`);
  try { return JSON.parse(text); } catch { throw new Error('期交所回傳的不是 JSON：' + text.slice(0, 120)); }
}

async function quoteList(cid, mt) {
  return post('getQuoteList', { MarketType: mt, SymbolType: 'F', KindID: '1', CID: cid, ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' });
}

export default async (req) => {
  const u = new URL(req.url);
  const a = u.searchParams.get('a') || 'quote';
  const cid = (u.searchParams.get('cid') || 'MXF').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'MXF';
  const mtIn = u.searchParams.get('mt');
  const mt = mtIn === '0' || mtIn === '1' ? mtIn : autoSession();
  try {
    if (a === 'raw') return json(await quoteList(cid, mt));

    if (a === 'quote') {
      const j = await quoteList(cid, mt);
      const list = j?.RtData?.QuoteList || [];
      // 去掉價差單（名稱有 /）、沒有成交價的；成交量最大的那個通常就是近月
      const rows = list
        .filter(q => !String(q.DispCName || '').includes('/') && !String(q.SymbolID || '').includes('/'))
        .map(q => ({ q, price: num(q.CLastPrice), vol: num(q.CTotalVolume) }))
        .filter(x => x.price > 0);
      if (!rows.length) return json({ ok: false, mt, error: list.length ? '目前沒有成交（可能還沒開盤或已收盤）' : '期交所沒有回傳小台資料', n: list.length });
      rows.sort((x, y) => (y.vol || 0) - (x.vol || 0));
      const { q, price, vol } = rows[0];
      return json({
        ok: true, mt, sym: q.SymbolID || '', name: q.DispCName || '小台', price, vol: vol || 0,
        time: q.CTime || '', date: q.CDate || '', open: num(q.COpenPrice), high: num(q.CHighPrice), low: num(q.CLowPrice),
        ref: num(q.CRefPrice), bid: num(q.CBidPrice1), ask: num(q.CAskPrice1), status: q.Status || '', serverTime: Date.now()
      });
    }

    if (a === 'hist') {
      const sym = (u.searchParams.get('sym') || '').replace(/[^A-Za-z0-9\-]/g, '').slice(0, 20);
      if (!sym) return json({ ok: false, error: '缺少 sym' }, 400);
      return json({ ok: true, data: await post('getChartData1M', { SymbolID: sym }) });
    }

    return json({ ok: false, error: '不認得的 a 參數' }, 400);
  } catch (e) {
    return json({ ok: false, mt, error: String(e?.message || e) }, 502);
  }
};

export const config = { path: '/api/mxf' };
