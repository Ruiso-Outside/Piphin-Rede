// Piphin Rede · contas do Wi-Fi: faixa e canal pela frequência, quanto cada rede ocupa do espectro,
// congestionamento do canal e o canal mais livre de cada faixa.
"use strict";

const band = (f) => (f < 2500 ? "2.4" : f < 5925 ? "5" : "6");
function channelOf(f) {
  if (f < 2500) return f === 2484 ? 14 : Math.round((f - 2407) / 5);
  if (f < 5925) return Math.round((f - 5000) / 5);
  return Math.round((f - 5950) / 5);
}
const freqOf = (b, ch) => (b === "2.4" ? (ch === 14 ? 2484 : 2407 + ch * 5) : b === "5" ? 5000 + ch * 5 : 5950 + ch * 5);

// trecho do espectro (MHz) que a rede ocupa: o canal principal e os vizinhos que ela junta (40/80/160/320 MHz)
function span(b, ch, width) {
  if (b === "2.4") {
    const f = freqOf(b, ch);
    if (width >= 40) return ch <= 7 ? [f - 11, f + 31] : [f - 31, f + 11];
    return [f - 11, f + 11];
  }
  const step = width / 5; // canais de 20 MHz contam de 4 em 4
  let first = ch;
  if (width > 20) {
    const base = b === "6" ? 1 : ch >= 149 ? 149 : 36;
    first = ch - ((((ch - base) % step) + step) % step);
  }
  const f0 = freqOf(b, first);
  return [f0 - 10, f0 - 10 + width];
}
const overlap = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
// peso de uma rede vizinha pelo sinal: forte atrapalha muito, fraca quase nada
const weight = (rssi) => (rssi >= -60 ? 1 : rssi >= -70 ? 0.7 : rssi >= -80 ? 0.35 : 0.12);

// canais que valem como sugestão em cada faixa (os comuns em roteadores)
const CANDIDATES = { "2.4": [1, 6, 11], "5": [36, 44, 52, 60, 100, 108, 116, 124, 132, 149, 157], "6": [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213] };

// mesmo roteador: BSSIDs iguais tirando o primeiro byte (redes 2.4/5 GHz e de convidados do mesmo aparelho)
const sameDevice = (a, b) => a.slice(3) === b.slice(3) || a.slice(0, 14) === b.slice(0, 14);

function analyze(networks, conn) {
  const list = networks.map((n) => {
    const b = band(n.FreqMhz), ch = channelOf(n.FreqMhz);
    return { ssid: n.Ssid, bssid: n.Bssid, band: b, channel: ch, freq: n.FreqMhz, width: n.Width || 20, rssi: n.Rssi, quality: n.Quality,
      standard: n.Standard, security: n.Security, phy: n.Phy, mine: !!(conn && n.Bssid === conn.Bssid), span: span(b, ch, n.Width || 20) };
  });
  const mine = list.find((n) => n.mine) || null;
  const others = (excl) => list.filter((n) => !n.mine && !(excl && sameDevice(n.bssid, excl.bssid)));
  // congestionamento de um trecho: soma do quanto cada vizinha encosta nele, pesada pelo sinal
  const load = (b, sp, excl) => others(excl).filter((n) => n.band === b).reduce((s, n) => s + (overlap(sp, n.span) / (sp[1] - sp[0])) * weight(n.rssi), 0);
  const bands = {};
  for (const b of ["2.4", "5", "6"]) {
    const here = list.filter((n) => n.band === b);
    if (!here.length) continue;
    const w = mine && mine.band === b ? mine.width : b === "2.4" ? 20 : 80;
    const scores = CANDIDATES[b].map((ch) => ({ channel: ch, load: +load(b, span(b, ch, w), mine).toFixed(2), count: others(mine).filter((n) => n.band === b && overlap(span(b, ch, w), n.span) > 0).length }));
    const best = [...scores].sort((x, y) => x.load - y.load || x.channel - y.channel)[0];
    bands[b] = { networks: here.length, scores, best };
  }
  let current = null;
  if (mine) {
    const cur = load(mine.band, mine.span, mine);
    const neighbors = others(mine).filter((n) => n.band === mine.band && overlap(mine.span, n.span) > 0).length;
    // a mesma rede (mesmo nome) em outra faixa, com sinal bom
    const twin = list.filter((n) => !n.mine && n.ssid && n.ssid === mine.ssid && n.band !== mine.band).sort((a, b) => b.rssi - a.rssi)[0] || null;
    current = { ...mine, load: +cur.toFixed(2), neighbors, best: bands[mine.band] && bands[mine.band].best, twin };
  }
  return { list, bands, current };
}

module.exports = { analyze, band, channelOf, span };
