# 小台看盤（xiaotai-kanpan）

小型臺指期貨（小台）開根號盯盤・模擬交易頁，台灣配色（漲紅跌綠）。

- 關鍵價位：兩個轉折點相乘再開根號 √(A×B)，由最新一根往左找轉折
- 商品：小台近全／近月／次全／次月（全＝日盤＋夜盤，月＝只看日盤；近＝近月合約，次＝次月合約）
- 週期：1／5／15／60 分K（網頁開著時用即時報價自己組，存在手機），日／週／月K（期交所每日行情）
- 成交量虛線訊號、根號移動停損、小台模擬帳戶（1 點 50 元）、回測
- `netlify/edge-functions/mxe.js`：即時報價（期交所 MIS），邊緣函式，路徑 `/api/mxe`（主要）
- `netlify/functions/mxf.mjs`：同上，一般函式，路徑 `/api/mxf`（備用）
- `netlify/functions/mtx.js`：期交所每日行情連續近月日K，路徑 `/api/mtx`
- 姊妹專案：[binance-sim](https://github.com/tim001491/binance-sim)（幣安版）
