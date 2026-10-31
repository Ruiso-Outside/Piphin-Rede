// Piphin Rede · tela. Mostra a conexão, o Wi-Fi (sinal, frequências e canais), o uso ao vivo, os aparelhos da rede,
// testes de ping, DNS e velocidade, e explica em linguagem simples o que pode estar deixando a rede lenta.
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const call = async (ch, ...a) => { const r = await piphin.invoke(ch, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const T = (x) => (window.piphinT ? window.piphinT(x) : x); // textos desenhados no canvas
const num = (v, d = 0) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
// bytes por segundo -> texto em bits (como as operadoras anunciam)
const rate = (bps) => { const b = (bps || 0) * 8; return b >= 1e9 ? `${num(b / 1e9, 2)} Gbps` : b >= 1e6 ? `${num(b / 1e6, b >= 1e8 ? 0 : 1)} Mbps` : b >= 1e3 ? `${num(b / 1e3, 0)} kbps` : `${num(b, 0)} bps`; };
const size = (n) => (n >= 1e9 ? `${num(n / 1e9, 1)} GB` : n >= 1e6 ? `${num(n / 1e6, 0)} MB` : `${num(n / 1e3, 0)} KB`);
const GEN = { 7: "Wi-Fi 7 (802.11be)", 6: "Wi-Fi 6 (802.11ax)", 5: "Wi-Fi 5 (802.11ac)", 4: "Wi-Fi 4 (802.11n)" };
const bandName = (b) => `${b === "2.4" ? num(2.4, 1) : b} GHz`;

const S = { tab: "home", ov: null, scan: null, scanBand: null, scanning: false, diag: null, diagRunning: false, steps: [], live: [], progs: null, devs: null, sweeping: false,
  lat: null, latRunning: false, dns: null, dnsRunning: false, speed: { running: false, phase: "", mbps: 0, result: null }, speedHist: [] };

// ---------------------------------------------------------------- avisos e diálogos
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = text;
  $("#toasts").appendChild(el); setTimeout(() => el.remove(), 4000);
}
const modal = $("#modal"), box = $("#modalBox");
const openModal = (html) => { box.className = "modal-box"; box.innerHTML = html; modal.hidden = false; };
const closeModal = () => { modal.hidden = true; box.innerHTML = ""; };
modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeModal(); });
const confirmBox = (title, text, yes = "Continuar") => new Promise((resolve) => {
  openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="modal-actions"><button class="btn" data-n>Cancelar</button><button class="btn primary" data-y>${esc(yes)}</button></div>`);
  box.querySelector("[data-y]").onclick = () => { closeModal(); resolve(true); };
  box.querySelector("[data-n]").onclick = () => { closeModal(); resolve(false); };
});
const promptBox = (title, label, value) => new Promise((resolve) => {
  openModal(`<h3>${esc(title)}</h3><div class="form"><label>${esc(label)}<input type="text" id="pIn" maxlength="40" value="${esc(value)}"></label></div>
    <div class="modal-actions"><button class="btn" data-n>Cancelar</button><button class="btn primary" data-y>OK</button></div>`);
  const ok = () => { const v = $("#pIn").value.trim(); closeModal(); resolve(v); };
  box.querySelector("[data-y]").onclick = ok;
  box.querySelector("[data-n]").onclick = () => { closeModal(); resolve(null); };
  $("#pIn").onkeydown = (e) => { if (e.key === "Enter") ok(); };
  setTimeout(() => $("#pIn").select(), 0);
});
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, "err"); } };

// ---------------------------------------------------------------- eventos do motor
piphin.on("live", (pt) => {
  S.live.push(pt); if (S.live.length > 180) S.live.shift();
  $("#pillDown").textContent = rate(pt.rx); $("#pillUp").textContent = rate(pt.tx);
  if (S.tab === "home" || S.tab === "usage") { drawLive(); const d = $("#nowDown"), u = $("#nowUp"); if (d) d.innerHTML = bigRate(pt.rx); if (u) u.innerHTML = bigRate(pt.tx); }
});
piphin.on("progress", (t) => { if (S.diagRunning && S.steps[S.steps.length - 1] !== t) { S.steps.push(t); if (S.tab === "home") render(); } });
piphin.on("speed", (s) => {
  if (s.phase === "done") { S.speed = { running: false, phase: "", mbps: 0, result: s.result }; S.speedHist = [s.result, ...S.speedHist].slice(0, 20); }
  else S.speed = { ...S.speed, phase: s.phase, mbps: s.mbps };
  if (S.tab === "tests") { const g = $("#gaugeNum"); if (g && S.speed.running) { g.textContent = num(S.speed.mbps, 1); $("#gaugeLbl").textContent = S.speed.phase === "up" ? T("Mbps enviando") : T("Mbps baixando"); } else render(); }
});
const bigRate = (bps) => { const t = rate(bps).split(" "); return `${t[0]}<small>${t[1]}</small>`; };

// ---------------------------------------------------------------- abas
$$(".p-subnav [data-tab]").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; $$(".p-subnav [data-tab]").forEach((x) => x.classList.toggle("active", x === b)); render(); loadTab(); }));
let progTimer = 0;
async function loadTab() {
  clearInterval(progTimer);
  try {
    if (S.tab === "wifi" && !S.scan && !S.scanning) await doScan();
    if (S.tab === "usage") { await loadProgs(); progTimer = setInterval(() => loadProgs().catch(() => {}), 5000); }
    if (S.tab === "devices" && !S.devs) { S.devs = await call("devices"); render(); }
    if (S.tab === "tests" && !S.speedHist.length) { S.speedHist = await call("speed-history"); render(); }
  } catch (e) { toast(e.message, "err"); }
}
async function loadProgs() { S.progs = await call("programs"); if (S.tab === "usage") render(); }
async function doScan() {
  S.scanning = true; render();
  try { S.scan = await call("scan"); if (!S.scanBand || !(S.scan.bands || {})[S.scanBand]) S.scanBand = (S.scan.current && S.scan.current.band) || Object.keys(S.scan.bands || {})[0] || "5"; }
  finally { S.scanning = false; render(); }
}
function render() {
  const v = { home, wifi: wifiTab, usage, devices, tests }[S.tab];
  const keep = $("main").scrollTop;
  $("#content").innerHTML = `<div class="wrap">${v ? v() : ""}</div>`;
  $("main").scrollTop = keep;
  drawLive(); drawSpectrum();
}
const loading = (t) => `<div class="card row"><span class="spin"></span><span class="muted">${esc(t)}</span></div>`;
const bars = (q, color) => { const n = q >= 75 ? 4 : q >= 50 ? 3 : q >= 25 ? 2 : q > 0 ? 1 : 0; return `<span class="bars" style="--bc:${color || (q >= 50 ? "#4ade80" : q >= 30 ? "#fbbf24" : "#f87171")}">${[0, 1, 2, 3].map((i) => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`; };
const qualityOf = (rssi) => Math.max(0, Math.min(100, 2 * (rssi + 100)));

// ---------------------------------------------------------------- visão geral
function verdict(s) {
  if (s >= 85) return ["Sua rede está ótima", "Não encontramos nada sério atrapalhando a conexão.", "#22c55e"];
  if (s >= 65) return ["Sua rede está bem", "Algumas coisas podem estar tirando um pouco de velocidade. Veja abaixo.", "#14b8a6"];
  if (s >= 45) return ["Tem coisas atrapalhando a rede", "Encontramos o que pode estar deixando a conexão lenta. Veja o que fazer abaixo.", "#fb923c"];
  return ["A rede está com problemas", "Encontramos problemas sérios na conexão. Comece pelos primeiros da lista.", "#f87171"];
}
function ring(score, color) {
  const r = 86, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  return `<div class="ring" style="--ring-c:${color}55"><svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14"/>
    <circle cx="100" cy="100" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>
    <div class="val"><b>${score}</b><span>saúde da rede</span></div></div>`;
}
function home() {
  const ov = S.ov;
  if (!ov) return loading("Lendo a conexão...");
  const d = S.diag, w = ov.wifi, m = ov.main;
  let title, text, color = "#14b8a6";
  if (!m) [title, text] = ["Sem conexão", "Nenhuma placa de rede está conectada. Confira o cabo ou conecte-se a uma rede Wi-Fi."];
  else if (d) [title, text, color] = verdict(d.score);
  else [title, text] = [w ? `Conectado ao Wi-Fi ${w.ssid || ""}`.trim() : "Conectado por cabo", "Clique em Diagnosticar para ver se algo está deixando a rede lenta: sinal, canal, ping, DNS e programas baixando."];
  const lat = d ? d.latency : S.lat;
  const inet = lat && lat.filter((x) => x.id !== "gateway" && x.avg != null).sort((a, b) => a.avg - b.avg)[0];
  const stats = [
    m ? (w ? ["wifi", w.ssid || "Rede oculta", "rede Wi-Fi"] : ["ethernet-port", "Cabo de rede", "tipo de conexão"]) : ["wifi-off", "Desconectado", "conexão"],
    w ? ["signal", `${w.signal}%`, `sinal (${w.rssi} dBm)`] : m ? ["gauge", m.speed > 0 ? `${num(m.speed / 1e6)} Mbps` : "--", "velocidade do cabo"] : ["gauge", "--", "sinal"],
    w ? ["zap", `${num(w.rx)} Mbps`, "velocidade do Wi-Fi"] : ["router", m && m.gateway || "--", "roteador"],
    ["timer", inet ? `${num(inet.avg)} ms` : "--", "ping até a internet"],
  ];
  return `
    <section class="hero">
      ${d ? ring(d.score, color) : `<div class="ring"><div class="val"><i class="i i-${!m ? "wifi-off" : w ? "wifi" : "ethernet-port"}"></i><span>${!m ? "sem rede" : ov.internet === false ? "sem internet" : "conectado"}</span></div></div>`}
      <div><h2>${esc(title)}</h2><p>${esc(text)}</p>
        <div class="acts">
          <button class="btn big teal" data-act="diagnose" ${S.diagRunning || !m ? "disabled" : ""}>${S.diagRunning ? `<span class="spin"></span>Diagnosticando...` : `<i class="i i-scan-search"></i>${d ? "Diagnosticar de novo" : "Diagnosticar a rede"}`}</button>
          <button class="btn big" data-act="go-speed" ${!m ? "disabled" : ""}><i class="i i-gauge"></i>Testar velocidade</button>
        </div>
        ${S.diagRunning ? `<div class="steps">${S.steps.map((s, i) => `<div>${i < S.steps.length - 1 ? `<i class="i i-check"></i>` : `<span class="spin"></span>`}${esc(s)}</div>`).join("")}</div>` : ""}
      </div>
    </section>
    <div class="grid3" style="grid-template-columns:repeat(4,1fr)">${stats.map(([ic, b, s]) => `<div class="stat"><i class="i i-${ic}"></i><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("")}</div>
    ${d ? `<div><h3 class="h"><i class="i i-list"></i>O que encontramos</h3>${d.findings.length ? `<div class="finds">${d.findings.map(findCard).join("")}</div>`
      : `<div class="allgood"><i class="i i-circle-check"></i><div><b>Nada atrapalhando a rede</b><div class="faint">Sinal, canal, ping, DNS e programas estão em ordem. Se ainda parece lento, faça o teste de velocidade.</div></div></div>`}</div>` : ""}
    <div class="grid2">
      <div class="card"><h3 class="h"><i class="i i-activity"></i>Uso agora</h3>
        <div class="row" style="gap:28px;margin-bottom:8px"><div><div class="faint">Baixando</div><div class="big-num" id="nowDown" style="color:var(--down)">${bigRate(lastLive().rx)}</div></div>
        <div><div class="faint">Enviando</div><div class="big-num" id="nowUp" style="color:var(--up)">${bigRate(lastLive().tx)}</div></div></div>
        <canvas class="chart small" id="liveChart"></canvas></div>
      <div class="card"><h3 class="h"><i class="i i-${w ? "wifi" : "network"}"></i>Sua conexão</h3>${connKv(ov)}</div>
    </div>`;
}
const lastLive = () => S.live[S.live.length - 1] || { rx: 0, tx: 0 };
const ACTIONS = { wifi: ["Abrir Wi-Fi do Windows", "settings:wifi"], "wifi-tab": ["Ver canais", "tab:wifi"], usage: ["Ver o uso", "tab:usage"], update: ["Abrir configurações", "settings:update"],
  network: ["Configurações de rede", "settings:network"], renew: ["Renovar o IP", "renew"] };
function findCard(f) {
  const icon = { alto: "circle-alert", "médio": "triangle-alert", baixo: "info" }[f.level] || "info";
  const a = f.action && ACTIONS[f.action];
  return `<div class="find"><div class="ic ${esc(f.level)}"><i class="i i-${icon}"></i></div><div class="grow"><h4>${esc(f.title)}</h4><p>${esc(f.text)}</p></div>
    ${a ? `<button class="btn sm" data-act="${esc(a[1])}">${esc(a[0])}<i class="i i-chevron-right"></i></button>` : ""}</div>`;
}
function connKv(ov) {
  const m = ov.main, w = ov.wifi;
  if (!m) return `<p class="faint">Nenhuma placa de rede conectada.</p>`;
  const sc = S.scan && S.scan.current;
  const rows = [
    ...(w ? [["Rede", `<span data-noi18n>${esc(w.ssid || "")}</span>`], ["Sinal", `${bars(w.signal)} ${w.signal}% · ${w.rssi} dBm`],
      ["Faixa e canal", sc ? `${bandName(w.band)} · canal ${w.channel} · ${num(sc.freq)} MHz · ${sc.width} MHz de largura` : `${bandName(w.band)} · canal ${w.channel}`],
      ["Padrão", esc(GEN[w.gen] || "Mais antigo")], ["Velocidade do Wi-Fi", `${num(w.rx)} Mbps recebendo · ${num(w.tx)} Mbps enviando`], ["Segurança", esc(w.security)]]
      : [["Velocidade do cabo", m.speed > 0 ? `${num(m.speed / 1e6)} Mbps` : "--"]]),
    ["Placa de rede", `<span data-noi18n>${esc(m.description)}</span>`],
    ["Endereço IP", `<span data-noi18n>${esc(m.ipv4.map((x) => x.ip).join(", ") || "--")}</span>`],
    ["Roteador", m.gateway ? `<a href="http://${esc(m.gateway)}" target="_blank" data-noi18n>${esc(m.gateway)}</a>` : "--"],
    ["DNS", `<span data-noi18n>${esc(m.dns.filter((x) => !x.includes(":")).slice(0, 2).join(", ") || m.dns.slice(0, 2).join(", ") || "--")}</span>`],
    ["IPv6", m.ipv6.length ? "Sim" : "Não"],
    ...(ov.vpn.length ? [["VPN", `<span data-noi18n>${esc(ov.vpn.join(", "))}</span>`]] : []),
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

// ---------------------------------------------------------------- Wi-Fi
const SEC = { open: "Aberta" };
function wifiTab() {
  const ov = S.ov;
  if (!ov) return loading("Lendo a conexão...");
  if (!ov.hasWifiCard) return `<div class="card"><h3 class="h"><i class="i i-wifi-off"></i>Este PC não tem Wi-Fi</h3><p class="muted">A conexão é por cabo. As abas Uso, Aparelhos e Testes funcionam normalmente.</p></div>`;
  const sc = S.scan, cur = sc && sc.current, w = ov.wifi;
  const head = `<div class="row"><div class="grow"><h1 class="t">Wi-Fi</h1><p class="sub">Sinal, frequências e canais da sua rede e das redes vizinhas.</p></div>
    <button class="btn" data-act="rescan" ${S.scanning ? "disabled" : ""}>${S.scanning ? `<span class="spin"></span>Procurando redes...` : `<i class="i i-refresh-cw"></i>Procurar de novo`}</button></div>`;
  if (!sc) return head + loading("Procurando as redes Wi-Fi por perto (uns 5 segundos)...");
  const blocked = sc.blocked ? `<div class="banner"><i class="i i-map-pin"></i><div class="grow">O Windows só mostra as redes por perto com a Localização ligada. Ative "Localização" e "Permitir que aplicativos da área de trabalho acessem sua localização".</div>
    <button class="btn sm" data-act="settings:location">Abrir Localização</button></div>` : "";
  const bandsAvail = Object.keys(sc.bands || {});
  const b = sc.bands[S.scanBand];
  const curCard = w && cur ? `<div class="card"><h3 class="h"><i class="i i-wifi"></i>Sua rede: <span data-noi18n>${esc(w.ssid || "")}</span></h3>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr);margin-bottom:14px">
        <div class="stat"><i class="i i-signal"></i><b>${w.signal}%</b><span>sinal (${w.rssi} dBm)</span></div>
        <div class="stat"><i class="i i-radio"></i><b>${bandName(cur.band)} · ${cur.channel}</b><span>faixa e canal</span></div>
        <div class="stat"><i class="i i-waves"></i><b>${num(cur.freq)} MHz</b><span>frequência (${cur.width} MHz de largura)</span></div>
        <div class="stat"><i class="i i-zap"></i><b>${num(w.rx)} Mbps</b><span>velocidade do Wi-Fi</span></div>
      </div>
      <dl class="kv"><dt>Padrão</dt><dd>${esc(GEN[w.gen] || "Mais antigo")}${ov.main && ov.main.adapterGen > w.gen ? ` · <span class="faint">${esc(`seu PC aceita até Wi-Fi ${ov.main.adapterGen}`)}</span>` : ""}</dd>
        <dt>Segurança</dt><dd>${esc(w.security)}</dd><dt>Roteador (BSSID)</dt><dd data-noi18n>${esc(w.bssid)}</dd>
        <dt>Vizinhos no mesmo canal</dt><dd>${cur.neighbors === 0 ? "Nenhum" : cur.neighbors === 1 ? "1 rede" : `${cur.neighbors} redes`}</dd>
        <dt>Canal mais livre agora</dt><dd>${cur.best ? (cur.best.channel === cur.channel || cur.load < 1 || cur.best.load >= cur.load * 0.6 ? "O seu canal já é uma boa escolha" : `Canal ${cur.best.channel} (troque nas configurações do roteador)`) : "--"}</dd>
        ${cur.twin ? `<dt>A mesma rede em ${bandName(cur.twin.band)}</dt><dd>${bars(qualityOf(cur.twin.rssi))} ${cur.twin.rssi} dBm</dd>` : ""}</dl></div>` : "";
  const spec = b ? `<div class="card"><div class="row" style="margin-bottom:10px"><h3 class="h grow" style="margin:0"><i class="i i-waves"></i>Frequências</h3>
      <div class="seg-tabs">${bandsAvail.map((k) => `<button class="${k === S.scanBand ? "on" : ""}" data-band="${k}">${bandName(k)}</button>`).join("")}</div></div>
      <canvas class="chart spectrum" id="spectrum"></canvas>
      <div class="legend" style="margin-top:8px"><span><i class="sw" style="background:#14b8a6"></i>Sua rede</span><span><i class="sw" style="background:#64748b"></i>Redes vizinhas</span>
        <span class="faint">Cada curva é uma rede: a largura é o pedaço da frequência que ela ocupa, a altura é a força do sinal aqui.</span></div>
      <h3 class="h" style="margin-top:18px"><i class="i i-chart-column"></i>Canais: quanto cada um está ocupado</h3>
      ${channelBars(b)}</div>` : "";
  const list = [...sc.list].sort((x, y) => y.mine - x.mine || y.rssi - x.rssi);
  const table = `<div class="card"><h3 class="h"><i class="i i-list"></i>${list.length === 1 ? "1 rede por perto" : `${list.length} redes por perto`}</h3>
    <table class="table"><thead><tr><th>Nome</th><th>Sinal</th><th>Faixa</th><th class="num">Canal</th><th class="num">Largura</th><th>Padrão</th><th>Segurança</th></tr></thead><tbody>
    ${list.map((n) => `<tr class="${n.mine ? "me" : ""}"><td class="nm">${n.ssid ? `<span data-noi18n>${esc(n.ssid)}</span>` : `<span class="faint">Rede oculta</span>`}${n.mine ? ` <span class="badge me">sua rede</span>` : ""}</td>
      <td>${bars(qualityOf(n.rssi))} <span class="faint">${n.rssi} dBm</span></td><td>${bandName(n.band)}</td><td class="num">${n.channel}</td><td class="num">${n.width} MHz</td>
      <td>${n.standard ? `Wi-Fi ${n.standard}` : `<span class="faint">antigo</span>`}</td><td>${n.security === "open" ? `<span class="badge bad">Aberta</span>` : esc(n.security)}</td></tr>`).join("")}
    </tbody></table></div>`;
  return head + blocked + curCard + spec + table;
}
function channelBars(b) {
  const max = Math.max(1, ...b.scores.map((s) => s.load));
  return `<div style="display:grid;gap:6px">${b.scores.map((s) => `<div class="lat-row" style="grid-template-columns:90px 1fr 170px;padding:4px 0;border:0">
    <span><span>Canal ${s.channel}</span>${S.scan.current && S.scan.current.channel === s.channel ? " ★" : ""}</span>
    <div class="lat-bar"><i style="width:${Math.max(3, (s.load / max) * 100)}%;--c:${s.load < 0.5 ? "#4ade80" : s.load < 1.5 ? "#fbbf24" : "#f87171"}"></i></div>
    <span class="faint">${s.channel === b.best.channel ? "mais livre" : s.count === 0 ? "livre" : s.count === 1 ? "1 rede encosta" : `${s.count} redes encostam`}</span></div>`).join("")}</div>`;
}
const BAND_RANGE = { "2.4": [2400, 2490], "5": [5150, 5895], "6": [5925, 7125] };
function drawSpectrum() {
  const c = $("#spectrum"); if (!c || !S.scan) return;
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr);
  const [f0, f1] = BAND_RANGE[S.scanBand], pad = { l: 34, r: 10, t: 12, b: 26 };
  const x = (f) => pad.l + ((f - f0) / (f1 - f0)) * (W - pad.l - pad.r), y = (rssi) => pad.t + (1 - (Math.max(-95, Math.min(-25, rssi)) + 95) / 70) * (H - pad.t - pad.b);
  g.font = "11px Segoe UI, sans-serif"; g.fillStyle = "rgba(255,255,255,.35)"; g.strokeStyle = "rgba(255,255,255,.06)";
  for (const db of [-90, -70, -50, -30]) { g.beginPath(); g.moveTo(pad.l, y(db)); g.lineTo(W - pad.r, y(db)); g.stroke(); g.fillText(String(db), 2, y(db) + 4); }
  // canais no eixo de baixo
  const chs = S.scanBand === "2.4" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] : S.scanBand === "5" ? [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157, 165] : [1, 33, 65, 97, 129, 161, 193, 225];
  const fOf = (ch) => (S.scanBand === "2.4" ? 2407 + ch * 5 : S.scanBand === "5" ? 5000 + ch * 5 : 5950 + ch * 5);
  g.textAlign = "center";
  for (const ch of chs) { const px = x(fOf(ch)); g.fillText(String(ch), px, H - 8); g.beginPath(); g.moveTo(px, H - pad.b); g.lineTo(px, H - pad.b + 4); g.stroke(); }
  const nets = S.scan.list.filter((n) => n.band === S.scanBand).sort((a, b) => a.mine - b.mine || a.rssi - b.rssi);
  const labels = [], boxes = [];
  for (const n of nets) {
    const a = x(n.span[0]), b = x(n.span[1]), top = y(n.rssi), base = H - pad.b, k = Math.min(14, (b - a) * 0.2);
    g.beginPath(); g.moveTo(a, base); g.bezierCurveTo(a + k, top, a + k, top, a + k * 2, top); g.lineTo(b - k * 2, top); g.bezierCurveTo(b - k, top, b - k, top, b, base);
    const col = n.mine ? "20,184,166" : "100,116,139";
    g.fillStyle = `rgba(${col},${n.mine ? 0.28 : 0.12})`; g.fill();
    g.lineWidth = n.mine ? 2.5 : 1.2; g.strokeStyle = `rgba(${col},${n.mine ? 1 : 0.7})`; g.stroke();
    if (n.mine || n.rssi > -78) {
      const same = labels.find((l) => !l.mine && !n.mine && Math.abs(l.cx - (a + b) / 2) < 4 && Math.abs(l.top - top) < 10);
      if (same) same.more++; else labels.push({ text: n.ssid || T("Rede oculta"), cx: (a + b) / 2, top, mine: n.mine, more: 0 });
    }
  }
  // a sua rede primeiro, depois as de sinal mais forte
  for (const l of labels.sort((x, y) => y.mine - x.mine || x.top - y.top)) {
    g.font = l.mine ? "600 12px Segoe UI, sans-serif" : "11px Segoe UI, sans-serif";
    const text = l.more ? `${l.text} +${l.more}` : l.text, w = g.measureText(text).width;
    let ty = l.top - 5;
    for (let k = 0; k < 4 && boxes.some((bx) => Math.abs(bx.x - l.cx) < (bx.w + w) / 2 + 4 && Math.abs(bx.y - ty) < 13); k++) ty -= 13;
    if (boxes.some((bx) => Math.abs(bx.x - l.cx) < (bx.w + w) / 2 + 4 && Math.abs(bx.y - ty) < 13) || ty < 10) continue;
    boxes.push({ x: l.cx, y: ty, w });
    g.fillStyle = l.mine ? "#5eead4" : "rgba(255,255,255,.6)"; g.fillText(text, l.cx, ty);
  }
}

// ---------------------------------------------------------------- uso
function usage() {
  const p = S.progs, live = S.live, peak = live.reduce((m, x) => Math.max(m, x.rx), 0);
  const up = p && p.update && p.update.jobs ? `<div class="card row"><i class="i i-hard-drive-download" style="font-size:22px;color:#fdba74"></i><div class="grow"><b>${p.update.jobs === 1 ? "O Windows Update está baixando 1 arquivo" : `O Windows Update está baixando ${p.update.jobs} arquivos`}</b>
      <div class="faint">${`${size(p.update.done)} de ${size(p.update.size)} baixados`}</div></div><button class="btn sm" data-act="settings:update">Configurações</button></div>` : "";
  return `<div><h1 class="t">Uso da rede</h1><p class="sub">Quanto a conexão está baixando e enviando agora, e quais programas estão conectados.</p></div>
    <div class="card"><div class="row" style="gap:34px;margin-bottom:12px">
      <div><div class="faint">Baixando agora</div><div class="big-num" id="nowDown" style="color:var(--down)">${bigRate(lastLive().rx)}</div></div>
      <div><div class="faint">Enviando agora</div><div class="big-num" id="nowUp" style="color:var(--up)">${bigRate(lastLive().tx)}</div></div>
      <div><div class="faint">Pico baixando</div><div class="big-num" style="font-size:20px">${bigRate(peak)}</div></div>
      <div class="grow"></div><div class="legend"><span><i class="sw" style="background:var(--down)"></i>Download</span><span><i class="sw" style="background:var(--up)"></i>Upload</span><span class="faint">últimos 2 minutos</span></div></div>
      <canvas class="chart" id="liveChart"></canvas></div>
    ${up}
    <div class="card"><h3 class="h"><i class="i i-app-window"></i>Programas conectados</h3>
      <p class="faint" style="margin:-4px 0 10px">O Windows só mostra quanto cada programa baixa com permissão de administrador. Aqui aparecem os programas conectados agora e quantas conexões cada um tem: muitas conexões costumam indicar downloads.</p>
      ${!p ? loading("Lendo as conexões...") : p.programs.length ? p.programs.slice(0, 40).map(progRow).join("") : `<p class="faint">Nenhum programa conectado.</p>`}</div>`;
}
const KIND_ICON = { torrent: "download", cloud: "cloud", games: "gamepad-2", update: "refresh-cw", stream: "tv", browser: "globe", vpn: "shield" };
function progRow(p) {
  const hot = (p.kind && ["torrent", "cloud", "games", "update"].includes(p.kind.id)) || p.est >= 30;
  return `<div class="prog"><div class="ic ${hot ? "hot" : ""}"><i class="i i-${KIND_ICON[p.kind && p.kind.id] || "app-window"}"></i></div>
    <div style="min-width:0"><b data-noi18n>${esc(p.desc || p.name)}</b> ${p.kind ? `<span class="badge ${hot ? "warn" : ""}">${esc(p.kind.label)}</span>` : ""}
      <div class="meta"><span>${p.est === 1 ? "1 conexão" : `${p.est} conexões`}</span> · <span>${p.remotes === 1 ? "1 servidor" : `${p.remotes} servidores`}</span>${p.listen ? ` · <span>aceita conexões</span>` : ""}</div></div>
    <span class="faint" data-noi18n>${esc(p.name)}.exe</span></div>`;
}
function drawLive() {
  const c = $("#liveChart"); if (!c) return;
  const dpr = devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (!W) return;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr);
  const pts = S.live.slice(-120), n = 120;
  const max = Math.max(125000, ...pts.map((p) => Math.max(p.rx, p.tx))) * 1.15;
  const x = (i) => (i + (n - pts.length)) / (n - 1) * W, y = (v) => H - 4 - (v / max) * (H - 18);
  g.strokeStyle = "rgba(255,255,255,.06)"; g.fillStyle = "rgba(255,255,255,.35)"; g.font = "10.5px Segoe UI, sans-serif";
  for (const k of [0.5, 1]) { g.beginPath(); g.moveTo(0, y(max * k / 1.15)); g.lineTo(W, y(max * k / 1.15)); g.stroke(); g.fillText(rate(max * k / 1.15), 4, y(max * k / 1.15) - 3); }
  for (const [key, col] of [["rx", "45,212,191"], ["tx", "167,139,250"]]) {
    if (pts.length < 2) continue;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p[key])) : g.moveTo(x(i), y(p[key]))));
    g.lineWidth = 2; g.strokeStyle = `rgb(${col})`; g.stroke();
    g.lineTo(x(pts.length - 1), H); g.lineTo(x(0), H); g.closePath(); g.fillStyle = `rgba(${col},.12)`; g.fill();
  }
}

// ---------------------------------------------------------------- aparelhos
function devices() {
  const d = S.devs;
  const head = `<div class="row"><div class="grow"><h1 class="t">Aparelhos na rede</h1><p class="sub">Celulares, PCs, TVs e outros aparelhos que o Windows viu na sua rede.</p></div>
    <button class="btn" data-act="sweep" ${S.sweeping ? "disabled" : ""}>${S.sweeping ? `<span class="spin"></span>Procurando...` : `<i class="i i-radar"></i>Procurar aparelhos`}</button></div>`;
  if (!d) return head + loading("Lendo a rede...");
  const self = d.self ? `<div class="dev"><div class="ic"><i class="i i-monitor"></i></div><div><b>Este PC</b> <span class="badge me">você</span><div class="meta" data-noi18n>${esc(d.self.ip)} · ${esc(d.self.mac)}</div></div><span class="faint" data-noi18n>${esc(d.self.name)}</span></div>` : "";
  const devIcon = (x) => { const t = (x.upnp && x.upnp.type || "").toLowerCase(); return x.router || t.includes("gateway") ? "router" : t.includes("mediarenderer") || t.includes("tv") || t.includes("dial") ? "tv" : t.includes("printer") ? "printer" : x.random ? "smartphone" : "monitor-smartphone"; };
  const rows = d.list.map((x) => `<div class="dev"><div class="ic ${x.router ? "router" : ""}"><i class="i i-${devIcon(x)}"></i></div>
      <div style="min-width:0"><b>${x.label ? `<span data-noi18n>${esc(x.label)}</span>` : x.name ? `<span data-noi18n>${esc(x.name)}</span>` : x.router ? "Roteador" : "Aparelho"}</b>
        ${x.router ? `<span class="badge info">roteador</span>` : ""}${x.random ? ` <span class="badge" title="Celulares e notebooks novos usam um endereço diferente em cada rede">endereço privado</span>` : ""}
        <div class="meta"><span class="dot ${x.online ? "" : "off"}"></span><span data-noi18n>${esc(x.ip)} · ${esc(x.mac)}${x.upnp && (x.upnp.maker || x.upnp.model) ? ` · ${esc([x.upnp.maker, x.upnp.model].filter(Boolean).join(" "))}` : ""}</span></div></div>
      <div class="row" style="gap:6px">${x.router ? `<a class="btn sm" href="http://${esc(x.ip)}" target="_blank"><i class="i i-external-link"></i>Abrir página</a>` : ""}
        <button class="btn sm ghost" data-label="${esc(x.mac)}" title="Dar um nome"><i class="i i-settings"></i></button></div></div>`).join("");
  return head + `<div class="card">${self}${rows}${!d.list.length ? `<p class="faint" style="margin-top:10px">Nenhum outro aparelho visto ainda. Clique em Procurar aparelhos.</p>` : ""}</div>
    <p class="faint"><span>${d.list.length === 1 ? "1 aparelho visto." : `${d.list.length} aparelhos vistos.`}</span> <span>Aparelhos desligados ou dormindo podem não aparecer. Bolinha verde: respondeu agora há pouco.</span></p>`;
}

// ---------------------------------------------------------------- testes
function tests() {
  const sp = S.speed, r = sp.result || S.speedHist[0];
  const speedCard = `<div class="card"><h3 class="h"><i class="i i-gauge"></i>Velocidade da internet</h3>
    ${sp.running ? `<div class="gauge"><div class="num" id="gaugeNum">${num(sp.mbps, 1)}</div><div class="lbl" id="gaugeLbl">${sp.phase === "up" ? "Mbps enviando" : "Mbps baixando"}</div></div>
      <div class="row" style="justify-content:center"><button class="btn" data-act="speed-cancel"><i class="i i-x"></i>Cancelar</button></div>`
      : `${r ? `<div class="speed-res">${[["arrow-down", `${num(r.down, 1)} Mbps`, "download"], ["arrow-up", `${num(r.up, 1)} Mbps`, "upload"], ["timer", `${num(r.ping)} ms`, "ping"]]
          .map(([ic, b, s]) => `<div class="stat"><i class="i i-${ic}"></i><b>${b}</b><span>${s}</span></div>`).join("")}</div>
          <p class="faint">${new Date(r.at).toLocaleString("pt-BR")}${r.server ? ` · <span>servidor ${esc(r.server)}</span>` : ""}</p>` : ""}
        <div class="row"><button class="btn big teal" data-act="speed"><i class="i i-play"></i>${r ? "Testar de novo" : "Testar velocidade"}</button>
        <span class="faint grow">Baixa e envia dados por uns 15 segundos usando os servidores da Cloudflare (speed.cloudflare.com). Só roda quando você clica.</span></div>`}
    ${S.speedHist.length > 1 ? `<h3 class="h" style="margin-top:16px"><i class="i i-history"></i>Testes anteriores</h3><table class="table"><thead><tr><th>Quando</th><th class="num">Download</th><th class="num">Upload</th><th class="num">Ping</th></tr></thead><tbody>
      ${S.speedHist.slice(0, 6).map((h) => `<tr><td>${new Date(h.at).toLocaleString("pt-BR")}</td><td class="num">${num(h.down, 1)} Mbps</td><td class="num">${num(h.up, 1)} Mbps</td><td class="num">${num(h.ping)} ms</td></tr>`).join("")}</tbody></table>` : ""}</div>`;
  const LBL = { gateway: "Roteador", cloudflare: "Internet (Cloudflare)", google: "Internet (Google)" };
  const latCard = `<div class="card"><div class="row" style="margin-bottom:8px"><h3 class="h grow" style="margin:0"><i class="i i-timer"></i>Ping e estabilidade</h3>
      <button class="btn" data-act="latency" ${S.latRunning ? "disabled" : ""}>${S.latRunning ? `<span class="spin"></span>Medindo...` : `<i class="i i-play"></i>Medir`}</button></div>
    <p class="faint" style="margin:0 0 8px">Ping é o tempo de ida e volta. Até o roteador mostra a sua rede de casa; até a internet mostra a operadora. Oscilação e perda causam travadas em jogos e chamadas.</p>
    ${S.lat ? S.lat.map((l) => { const c = l.avg == null ? "#f87171" : l.avg < 20 ? "#4ade80" : l.avg < 60 ? "#a3e635" : l.avg < 120 ? "#fbbf24" : "#f87171";
      return `<div class="lat2"><div class="row" style="gap:8px"><b>${esc(LBL[l.id] || l.ip)}</b><span class="faint grow" data-noi18n>${esc(l.ip)}</span>
          <span>${l.avg == null ? "não respondeu" : `${num(l.avg, 1)} ms · oscilação ${num(l.jitter, 1)} ms · perda ${l.loss}%`}</span></div>
        <div class="lat-bar"><i style="width:${l.avg == null ? 100 : Math.min(100, (l.avg / 150) * 100)}%;--c:${c}"></i></div></div>`; }).join("") : ""}</div>`;
  const best = S.dns && S.dns.filter((x) => x.ms != null).sort((a, b) => a.ms - b.ms)[0];
  const dnsCard = `<div class="card"><div class="row" style="margin-bottom:8px"><h3 class="h grow" style="margin:0"><i class="i i-server"></i>DNS</h3>
      <button class="btn" data-act="dns" ${S.dnsRunning ? "disabled" : ""}>${S.dnsRunning ? `<span class="spin"></span>Testando...` : `<i class="i i-play"></i>Testar`}</button></div>
    <p class="faint" style="margin:0 0 8px">O DNS transforma o nome dos sites em endereços. Um DNS lento faz os sites demorarem para começar a abrir.</p>
    ${S.dns ? `<table class="table"><thead><tr><th>Servidor</th><th></th><th class="num">Tempo</th></tr></thead><tbody>${S.dns.map((x) => `<tr><td data-noi18n>${esc(x.ip)}</td>
      <td>${x.own ? `<span class="badge me">o seu</span>` : esc(x.name)}${best && x === best ? ` <span class="badge ok">mais rápido</span>` : ""}</td><td class="num">${x.ms == null ? "não respondeu" : `${x.ms} ms`}</td></tr>`).join("")}</tbody></table>
      <p class="faint">Para trocar o DNS: Configurações do Windows > Rede e Internet > sua conexão > Atribuição de servidor DNS > Editar.</p>` : ""}</div>`;
  const tools = `<div class="card"><h3 class="h"><i class="i i-settings"></i>Ferramentas</h3><div class="tools">
      <button class="tool" data-act="flush"><i class="i i-trash-2"></i><b>Limpar o cache de DNS</b><span>Resolve sites que não abrem depois de mudarem de endereço.</span></button>
      <button class="tool" data-act="renew"><i class="i i-refresh-cw"></i><b>Renovar o IP</b><span>Pede um endereço novo ao roteador. A internet cai por alguns segundos.</span></button>
      <button class="tool" data-act="settings:network"><i class="i i-network"></i><b>Configurações de rede</b><span>Abre Rede e Internet nas configurações do Windows.</span></button>
      <button class="tool" data-act="settings:adapters"><i class="i i-ethernet-port"></i><b>Placas de rede</b><span>Lista clássica de conexões do Windows.</span></button>
      <button class="tool" data-act="settings:reset"><i class="i i-rotate-ccw"></i><b>Redefinir a rede</b><span>Abre as configurações avançadas, onde fica "Redefinição de rede" (último recurso).</span></button>
    </div></div>`;
  return `<div><h1 class="t">Testes</h1><p class="sub">Velocidade, ping, DNS e ferramentas para resolver problemas comuns.</p></div>${speedCard}<div class="grid2">${latCard}${dnsCard}</div>${tools}`;
}

// ---------------------------------------------------------------- cliques
document.addEventListener("click", guard(async (e) => {
  const band = e.target.closest("[data-band]");
  if (band) { S.scanBand = band.dataset.band; render(); return; }
  const lb = e.target.closest("[data-label]");
  if (lb) {
    const dev = S.devs.list.find((x) => x.mac === lb.dataset.label);
    const v = await promptBox("Nome do aparelho", "Nome (só aparece aqui)", dev.label || dev.name || "");
    if (v === null) return;
    await call("device-label", { mac: dev.mac, label: v }); dev.label = v; render(); return;
  }
  const a = e.target.closest("[data-act]"); if (!a || a.disabled) return;
  const act = a.dataset.act;
  if (act.startsWith("settings:")) return call("open-settings", act.slice(9));
  if (act.startsWith("tab:")) return $(`.p-subnav [data-tab="${act.slice(4)}"]`).click();
  if (act === "go-speed") { $(`.p-subnav [data-tab="tests"]`).click(); return startSpeed(); }
  if (act === "diagnose") {
    S.diagRunning = true; S.steps = []; render();
    try { S.diag = await call("diagnose"); S.ov = S.diag.overview; S.lat = S.diag.latency; if (S.diag.dns) S.dns = S.diag.dns; } finally { S.diagRunning = false; render(); }
  }
  if (act === "rescan") return doScan();
  if (act === "sweep") { S.sweeping = true; render(); try { S.devs = await call("devices", { sweep: true }); } finally { S.sweeping = false; render(); } }
  if (act === "speed") return startSpeed();
  if (act === "speed-cancel") return call("speed-cancel");
  if (act === "latency") { S.latRunning = true; render(); try { S.lat = await call("latency", { rounds: 25 }); } finally { S.latRunning = false; render(); } }
  if (act === "dns") { S.dnsRunning = true; render(); try { S.dns = await call("dns-bench"); } finally { S.dnsRunning = false; render(); } }
  if (act === "flush") { await call("flush-dns"); toast("Cache de DNS limpo", "ok"); }
  if (act === "renew") {
    if (!(await confirmBox("Renovar o IP?", "A internet cai por alguns segundos enquanto o roteador entrega um endereço novo.", "Renovar"))) return;
    toast("Renovando o IP...", "info"); await call("renew-ip"); S.ov = await call("overview"); toast("IP renovado", "ok"); render();
  }
}));
async function startSpeed() {
  if (S.speed.running) return;
  S.speed = { running: true, phase: "down", mbps: 0, result: null }; render();
  try { await call("speed-test"); } catch (e) { S.speed = { running: false, phase: "", mbps: 0, result: null }; toast(e.message, "err"); render(); }
}

// ---------------------------------------------------------------- início
(async () => {
  try {
    const hist = await call("live-start"); S.live = hist || [];
    S.ov = await call("overview"); render();
  } catch (e) { $("#content").innerHTML = `<div class="wrap"><div class="card"><b>Não foi possível ler a rede.</b><p class="faint">${esc(e.message)}</p></div></div>`; }
})();
window.addEventListener("resize", () => { drawLive(); drawSpectrum(); });
