// Piphin Rede como módulo do Piphin Hub: conexão, Wi-Fi (sinal, frequências e canais), uso da rede ao vivo, programas
// conectados, aparelhos da rede, testes (ping, DNS, velocidade) e o diagnóstico "por que a rede está lenta?".
// Só lê a rede. As ferramentas que mudam algo (limpar o cache de DNS, renovar o IP) pedem confirmação na tela.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const wifi = require("./wifi");

const SYS = process.env.SystemRoot || "C:\\Windows";
const exe = (name) => path.join(SYS, "System32", name);
const PS = exe("WindowsPowerShell\\v1.0\\powershell.exe");

function run(file, args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      const dec = (b) => { const s = (b || Buffer.alloc(0)).toString("utf8"); return s.includes("\uFFFD") ? b.toString("latin1") : s; };
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: dec(stdout), err: dec(stderr) });
    });
  });
}
// PowerShell avulso (testes demorados, para o motor continuar respondendo)
async function psJson(script, timeout = 120000) {
  const full = `$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$r = & { ${script} };$r | ConvertTo-Json -Depth 6 -Compress`;
  const r = await run(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", full], { timeout });
  const txt = r.out.trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { throw new Error("PowerShell: " + (r.err || txt).slice(0, 300)); }
}
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// programas que costumam pesar na rede, por nome do processo
const KINDS = [
  ["torrent", "Torrent", /^(qbittorrent|utorrent|bittorrent|transmission-qt|transmission-daemon|deluge|tixati|vuze|biglybt|frostwire|motrix)$/i],
  ["cloud", "Sincronização na nuvem", /^(onedrive|dropbox|googledrivefs|megasync|icloud.*|pcloud|nextcloud|syncthing|boxsync|box)$/i],
  ["games", "Loja de jogos", /^(steam|steamservice|epicgameslauncher|battle\.net|agent|eadesktop|eabackgroundservice|upc|ubisoftconnect|galaxyclient|riotclientservices|xboxpcapp|gamingservices|minecraftlauncher|rockstarservice|launcher)$/i],
  ["update", "Atualizações", /^(microsoftedgeupdate|googleupdate|updater|softwareupdate|adobearm|mousocoreworker|tiworker)$/i],
  ["stream", "Vídeo e chamadas", /^(discord|zoom|teams|ms-teams|obs64|obs|spotify|netflix|skype|whatsapp)$/i],
  ["browser", "Navegador", /^(chrome|msedge|firefox|opera|opera_gx|brave|vivaldi|arc)$/i],
  ["vpn", "VPN", /^(openvpn|openvpn-gui|wireguard|nordvpn|nordvpn-service|protonvpn|protonvpnservice|expressvpn|windscribe|hamachi-2|radmin_vpn|warp-svc|tailscaled)$/i],
];
const kindOf = (name) => { for (const [id, label, re] of KINDS) if (re.test(name || "")) return { id, label }; return null; };

exports.activate = (ctx) => {
  const PREFS = path.join(ctx.dataDir, "prefs.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  let prefs = readJson(PREFS, {});
  const savePrefs = () => { fs.mkdirSync(ctx.dataDir, { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 1)); };

  // ---------------------------------------------------------------- motor (PowerShell aberto, responde em JSON)
  let eng = null, seq = 0;
  const waiting = new Map();
  function engine() {
    if (eng) return eng;
    const p = spawn(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "engine.ps1")], { windowsHide: true });
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const w = waiting.get(j.id); if (!w) continue;
        waiting.delete(j.id); clearTimeout(w.t);
        j.ok ? w.resolve(j.data) : w.reject(new Error(j.error));
      }
    });
    p.stderr.on("data", (d) => ctx.log("motor", String(d).slice(0, 400)));
    p.on("exit", () => { if (eng === p) eng = null; for (const w of waiting.values()) { clearTimeout(w.t); w.reject(new Error("O motor da rede parou")); } waiting.clear(); });
    eng = p;
    return p;
  }
  function ask(cmd, a = {}, timeout = 30000) {
    const p = engine(), id = ++seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error("O motor da rede não respondeu")); }, timeout);
      waiting.set(id, { resolve, reject, t });
      p.stdin.write(JSON.stringify({ id, cmd, a }) + "\n");
    });
  }
  ctx.onStop(() => { stopLive(); if (eng) { try { eng.kill(); } catch {} eng = null; } });

  // ---------------------------------------------------------------- conexão
  const ADAPTER_GEN = (d) => (/wi-?fi 7|\bBE\d{3,}|802\.11be/i.test(d) ? 7 : /wi-?fi 6e?|\bAX\d{3,}|802\.11ax/i.test(d) ? 6 : /\bAC\d{3,}|802\.11ac/i.test(d) ? 5 : 0);
  const PHY_GEN = { 7: 4, 8: 5, 10: 6, 11: 7 };
  const AUTH = { 1: "Aberta", 2: "WEP", 3: "WPA-Enterprise", 4: "WPA", 6: "WPA2-Enterprise", 7: "WPA2", 8: "WPA3-Enterprise", 9: "WPA3", 10: "OWE", 11: "WPA3-Enterprise" };
  const isVirtual = (a) => /virtual|vmware|hyper-v|vethernet|tap-|tunnel|wireguard|vpn|loopback|bluetooth|wan miniport|npcap|zerotier|tailscale|hamachi|radmin/i.test(a.description + " " + a.name);
  let lastOverview = null;
  async function overview() {
    const [info, wf] = await Promise.all([ask("info"), ask("wifi").catch(() => ({ interfaces: [], connections: [] }))]);
    const adapters = arr(info.adapters).map((a) => ({ ...a, ipv4: arr(a.ipv4), ipv6: arr(a.ipv6), gateways: arr(a.gateways), dns: arr(a.dns), virtual: isVirtual(a) }));
    const main = adapters.filter((a) => a.up && a.gateways.length).sort((a, b) => a.virtual - b.virtual)[0] || adapters.find((a) => a.up && !a.virtual) || null;
    const conns = arr(wf.connections), ifaces = arr(wf.interfaces);
    const wc = main && conns.find((c) => main.id.toLowerCase().includes(c.Guid.toLowerCase())) || (main && main.type === "Wireless80211" ? conns[0] : null);
    const profile = main && arr(info.profiles).find((p) => p.alias === main.name);
    const vpn = adapters.filter((a) => a.up && a.virtual && /vpn|tap-|wireguard|tunnel|zerotier|tailscale|hamachi|radmin/i.test(a.description + " " + a.name)).map((a) => a.description);
    const out = {
      main: main && { name: main.name, description: main.description, type: main.type === "Wireless80211" ? "wifi" : main.type === "Ethernet" || main.type === "GigabitEthernet" ? "ethernet" : main.type,
        speed: main.speed, mac: main.mac, ipv4: main.ipv4, ipv6: main.ipv6, gateway: main.gateways[0] || null, dns: main.dns, dhcp: main.dhcp, mtu: main.mtu, id: main.id, virtual: main.virtual,
        adapterGen: ADAPTER_GEN(main.description) },
      wifi: wc && { ssid: wc.Ssid, bssid: wc.Bssid, profile: wc.Profile, signal: wc.Signal, rssi: wc.Rssi, channel: wc.Channel, rx: Math.round(wc.RxKbps / 1000), tx: Math.round(wc.TxKbps / 1000),
        gen: PHY_GEN[wc.Phy] || 0, phy: wc.Phy, security: AUTH[wc.Auth] || (wc.Secured ? "WPA2" : "Aberta"), band: wc.Channel > 14 ? "5" : "2.4" },
      internet: profile ? profile.v4 === 4 || profile.v6 === 4 : null, // 4 = acesso à internet (o Windows confere sozinho)
      profileName: profile && profile.name, vpn,
      adapters: adapters.filter((a) => !/wan miniport|loopback|teredo|isatap|6to4/i.test(a.description)).map((a) => ({ name: a.name, description: a.description, type: a.type, up: a.up, speed: a.speed, virtual: a.virtual, ipv4: a.ipv4.map((x) => x.ip) })),
      hasWifiCard: ifaces.length > 0,
    };
    lastOverview = out;
    return out;
  }
  ctx.handle("overview", () => overview());

  // ---------------------------------------------------------------- redes Wi-Fi por perto
  let lastScan = null;
  async function scan({ fresh = true } = {}) {
    const ov = lastOverview || await overview();
    if (fresh) { await ask("scan").catch(() => {}); await sleep(4200); }
    const r = await ask("bss", {}, 30000);
    const conn = ov.wifi ? { Bssid: ov.wifi.bssid } : null;
    const a = wifi.analyze(arr(r.networks), conn);
    // sem a Localização do Windows ligada, o Windows não deixa listar as redes (Windows 11 24H2+)
    lastScan = { at: Date.now(), error: r.error || 0, blocked: r.error === 5 || (ov.hasWifiCard && !arr(r.networks).length && !!ov.wifi), ...a };
    return lastScan;
  }
  ctx.handle("scan", (opts) => scan(opts || {}));

  // ---------------------------------------------------------------- uso ao vivo (bytes por segundo)
  let liveTimer = null, prev = null, liveUsers = 0;
  const live = [];
  async function tick() {
    try {
      const s = await ask("stats", {}, 8000);
      const mainId = lastOverview && lastOverview.main ? lastOverview.main.id : null;
      const list = arr(s.list), cur = mainId ? list.find((x) => x.id === mainId) : null;
      const pick = cur ? [cur] : list;
      const rx = pick.reduce((n, x) => n + x.rx, 0), tx = pick.reduce((n, x) => n + x.tx, 0);
      if (prev && s.at > prev.at) {
        const dt = (s.at - prev.at) / 1000;
        const pt = { t: s.at, rx: Math.max(0, (rx - prev.rx) / dt), tx: Math.max(0, (tx - prev.tx) / dt) };
        live.push(pt); if (live.length > 180) live.shift();
        ctx.emit("live", pt);
      }
      prev = { at: s.at, rx, tx };
    } catch (e) { ctx.log("uso", e.message); }
  }
  function startLive() { liveUsers++; if (!liveTimer) { prev = null; tick(); liveTimer = setInterval(tick, 1000); } }
  function stopLive(force) { liveUsers = force === false ? Math.max(0, liveUsers - 1) : 0; if (!liveUsers && liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
  ctx.handle("live-start", () => { startLive(); return live.slice(-120); });
  ctx.handle("live-stop", () => { stopLive(false); return true; });
  ctx.host.on("view-hidden", () => stopLive());
  ctx.host.on("view-shown", () => startLive());

  // ---------------------------------------------------------------- programas usando a rede
  async function programs() {
    const [c, d] = await Promise.all([ask("conns", {}, 30000), ask("do", {}, 30000).catch(() => ({ jobs: [], mode: null }))]);
    const list = arr(c.list).map((p) => ({ ...p, kind: kindOf(p.name) })).filter((p) => p.est || p.udp || p.listen);
    // junta processos do mesmo programa (navegadores abrem vários)
    const by = new Map();
    for (const p of list) {
      const k = (p.name || "?").toLowerCase();
      const g = by.get(k) || { name: p.name, desc: p.desc || "", path: p.path || "", kind: p.kind, pids: [], est: 0, udp: 0, listen: 0, remotes: 0 };
      g.pids.push(p.pid); g.est += p.est; g.udp += p.udp; g.listen += p.listen; g.remotes += p.remotes;
      if (!g.desc && p.desc) g.desc = p.desc;
      by.set(k, g);
    }
    const jobs = arr(d.jobs);
    return { programs: [...by.values()].sort((a, b) => b.est - a.est || b.remotes - a.remotes), update: { jobs: jobs.length, size: jobs.reduce((n, j) => n + j.size, 0), done: jobs.reduce((n, j) => n + j.done, 0), mode: d.mode } };
  }
  ctx.handle("programs", () => programs());

  // ---------------------------------------------------------------- aparelhos na rede
  // UPnP/SSDP: TVs, Chromecast, consoles, impressoras e roteadores respondem com nome, fabricante e modelo
  function ssdp(wait = 2500) {
    const dgram = require("dgram");
    return new Promise((resolve) => {
      const found = new Map(), sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      const msg = Buffer.from(["M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"', "MX: 2", "ST: ssdp:all", "", ""].join("\r\n"));
      sock.on("message", (m, r) => { const loc = /^location:\s*(\S+)/im.exec(String(m)); if (loc && !found.has(r.address)) found.set(r.address, loc[1]); });
      sock.on("error", () => {});
      sock.bind(0, () => { try { sock.send(msg, 1900, "239.255.255.250"); setTimeout(() => { try { sock.send(msg, 1900, "239.255.255.250"); } catch {} }, 600); } catch {} });
      setTimeout(async () => {
        try { sock.close(); } catch {}
        const out = {};
        await Promise.all([...found].map(async ([ip, url]) => {
          try {
            if (!/^https?:\/\//.test(url) || new URL(url).hostname !== ip) return; // só a descrição do próprio aparelho
            const ac = new AbortController(), t = setTimeout(() => ac.abort(), 1500);
            const xml = (await (await fetch(url, { signal: ac.signal })).text()).slice(0, 200000); clearTimeout(t);
            const tag = (n) => { const x = new RegExp("<" + n + ">([^<]{1,80})</" + n + ">", "i").exec(xml); return x ? x[1].trim() : ""; };
            out[ip] = { name: tag("friendlyName"), maker: tag("manufacturer"), model: tag("modelName"), type: (tag("deviceType").split(":")[3] || "") };
          } catch {}
        }));
        resolve(out);
      }, wait);
    });
  }
  async function devices({ sweep = false } = {}) {
    const ov = lastOverview || await overview();
    const m = ov.main;
    if (!m || !m.ipv4.length) return { list: [], self: null };
    const me = m.ipv4[0];
    let upnp = prefs.upnp || {};
    if (sweep) {
      const found = ssdp().catch(() => ({}));
      // pinga a rede local (no máximo 254 endereços, os do mesmo /24 do PC) para os aparelhos aparecerem na tabela do Windows
      const base = me.ip.split(".").slice(0, 3).join(".");
      await psJson(`$p = 1..254 | ForEach-Object { [Net.NetworkInformation.Ping]::new().SendPingAsync('${base}.' + $_, 600) }; try { [Threading.Tasks.Task]::WaitAll($p, 4000) | Out-Null } catch {}; @{ ok = $true }`, 30000).catch(() => {});
      upnp = { ...upnp, ...(await found) }; // guarda: na próxima abertura os nomes já aparecem
      prefs.upnp = upnp; savePrefs();
    }
    const n = await ask("neighbors", {}, 20000);
    const inNet = (ip) => { const a = ip.split(".").map(Number), b = me.ip.split(".").map(Number), bits = Math.min(32, me.prefix || 24); const v = (x) => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3]; const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0; return ((v(a) & mask) >>> 0) === ((v(b) & mask) >>> 0); };
    const seen = new Map();
    for (const x of arr(n.list)) if (inNet(x.ip) && x.ip !== me.ip && !seen.has(x.ip)) seen.set(x.ip, x);
    const ips = [...seen.keys()];
    const names = ips.length ? await ask("names", { ips }, 15000).catch(() => ({})) : {};
    const prevNames = prefs.deviceNames || {};
    const list = ips.map((ip) => {
      const x = seen.get(ip), first = parseInt(x.mac.slice(0, 2), 16);
      const u = upnp[ip] || null;
      return { ip, mac: x.mac, name: (names && names[ip]) || (u && u.name) || "", label: prevNames[x.mac] || "", upnp: u, router: ip === m.gateway, random: (first & 2) === 2, online: x.state === "Reachable" || x.state === "Delay" || x.state === "Probe" };
    }).sort((a, b) => b.router - a.router || a.ip.split(".").map(Number).reduce((s, v) => s * 256 + v, 0) - b.ip.split(".").map(Number).reduce((s, v) => s * 256 + v, 0));
    return { list, self: { ip: me.ip, mac: m.mac, name: process.env.COMPUTERNAME || "" } };
  }
  ctx.handle("devices", (o) => devices(o || {}));
  ctx.handle("device-label", ({ mac, label }) => { prefs.deviceNames = { ...(prefs.deviceNames || {}), [mac]: String(label || "").slice(0, 40) }; if (!label) delete prefs.deviceNames[mac]; savePrefs(); return true; });

  // ---------------------------------------------------------------- testes: ping, DNS, velocidade
  const stats = (r) => {
    const ok = r.filter((x) => x >= 0), loss = r.length ? Math.round(((r.length - ok.length) / r.length) * 100) : 100;
    if (!ok.length) return { avg: null, min: null, max: null, jitter: null, loss, samples: r };
    const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
    let j = 0; for (let i = 1; i < ok.length; i++) j += Math.abs(ok[i] - ok[i - 1]);
    return { avg: Math.round(avg * 10) / 10, min: Math.min(...ok), max: Math.max(...ok), jitter: ok.length > 1 ? Math.round((j / (ok.length - 1)) * 10) / 10 : 0, loss, samples: r };
  };
  async function latency({ rounds = 20 } = {}) {
    const ov = lastOverview || await overview();
    const targets = [...(ov.main && ov.main.gateway ? [["gateway", ov.main.gateway]] : []), ["cloudflare", "1.1.1.1"], ["google", "8.8.8.8"]];
    const r = await psJson(`$t = @(${targets.map(([, ip]) => `'${ip}'`).join(",")}); $res = @{}; foreach ($x in $t) { $res[$x] = @() }
      for ($i = 0; $i -lt ${Math.max(5, Math.min(60, rounds))}; $i++) {
        $tasks = @{}; foreach ($x in $t) { $tasks[$x] = [Net.NetworkInformation.Ping]::new().SendPingAsync($x, 1000) }
        foreach ($x in $t) { try { $p = $tasks[$x].GetAwaiter().GetResult(); $res[$x] += $(if ($p.Status -eq 'Success') { [int]$p.RoundtripTime } else { -1 }) } catch { $res[$x] += -1 } }
        Start-Sleep -Milliseconds 150 }
      $res`, 90000);
    return targets.map(([id, ip]) => ({ id, ip, ...stats(arr(r && r[ip]).map(Number)) }));
  }
  ctx.handle("latency", (o) => latency(o || {}));

  async function dnsBench() {
    const ov = lastOverview || await overview();
    const mine = (ov.main ? ov.main.dns : []).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x)).slice(0, 2);
    const servers = [...mine.map((ip) => ({ ip, name: "", own: true })), { ip: "1.1.1.1", name: "Cloudflare" }, { ip: "8.8.8.8", name: "Google" }, { ip: "9.9.9.9", name: "Quad9" }]
      .filter((s, i, a) => a.findIndex((x) => x.ip === s.ip) === i);
    const r = await psJson(`$names = 'www.google.com','www.wikipedia.org','www.microsoft.com','www.youtube.com'; $out = @{}
      foreach ($s in @(${servers.map((s) => `'${s.ip}'`).join(",")})) { $ms = @(); foreach ($n in $names) { $w = [Diagnostics.Stopwatch]::StartNew(); try { Resolve-DnsName -Name $n -Server $s -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop | Out-Null; $ms += [int]$w.ElapsedMilliseconds } catch { $ms += -1 } }; $out[$s] = $ms }
      $out`, 60000);
    return servers.map((s) => { const ms = arr(r && r[s.ip]).map(Number).filter((x) => x >= 0).sort((a, b) => a - b); return { ...s, ms: ms.length ? ms[Math.floor(ms.length / 2)] : null, fails: 4 - ms.length }; });
  }
  ctx.handle("dns-bench", () => dnsBench());

  // teste de velocidade com os servidores da Cloudflare (speed.cloudflare.com); só roda quando a pessoa pede
  let speedAbort = null;
  async function speedTest({ seconds = 8 } = {}) {
    if (speedAbort) throw new Error("Já tem um teste de velocidade em andamento");
    const ac = new AbortController(); speedAbort = ac;
    const BASE = "https://speed.cloudflare.com";
    try {
      // ping até o servidor
      const pings = []; let colo = "";
      for (let i = 0; i < 6 && !ac.signal.aborted; i++) {
        const t0 = performance.now(); const res = await fetch(`${BASE}/__down?bytes=0`, { signal: ac.signal, cache: "no-store" }); await res.arrayBuffer();
        pings.push(performance.now() - t0); colo = colo || res.headers.get("colo") || (res.headers.get("cf-ray") || "").split("-")[1] || "";
      }
      const ping = Math.round(Math.min(...pings));
      // download: 4 conexões ao mesmo tempo pedindo pedaços de 25 MB
      const phase = async (kind, dur) => {
        let bytes = 0; const t0 = performance.now(), end = t0 + dur * 1000;
        const tick = setInterval(() => ctx.emit("speed", { phase: kind, mbps: (bytes * 8) / ((performance.now() - t0) / 1000) / 1e6 }), 400);
        const worker = async () => {
          while (performance.now() < end && !ac.signal.aborted) {
            const sub = new AbortController(); const stop = setTimeout(() => sub.abort(), Math.max(0, end - performance.now()));
            const onAbort = () => sub.abort(); ac.signal.addEventListener("abort", onAbort);
            try {
              if (kind === "down") {
                const res = await fetch(`${BASE}/__down?bytes=25000000`, { signal: sub.signal, cache: "no-store" });
                const rd = res.body.getReader();
                for (;;) { const { done, value } = await rd.read(); if (done) break; bytes += value.length; }
              } else {
                const body = new Uint8Array(4 * 1024 * 1024);
                await fetch(`${BASE}/__up`, { method: "POST", body, signal: sub.signal });
                bytes += body.length;
              }
            } catch { /* fim do tempo */ } finally { clearTimeout(stop); ac.signal.removeEventListener("abort", onAbort); }
          }
        };
        await Promise.all(Array.from({ length: kind === "down" ? 4 : 3 }, worker));
        clearInterval(tick);
        return Math.round(((bytes * 8) / ((performance.now() - t0) / 1000) / 1e6) * 10) / 10;
      };
      ctx.emit("speed", { phase: "down", mbps: 0 });
      const down = await phase("down", seconds);
      ctx.emit("speed", { phase: "up", mbps: 0 });
      const up = await phase("up", Math.max(4, seconds - 2));
      if (ac.signal.aborted) throw new Error("Teste cancelado");
      const result = { at: Date.now(), ping, down, up, server: colo };
      prefs.speedHistory = [result, ...(prefs.speedHistory || [])].slice(0, 20); savePrefs();
      ctx.emit("speed", { phase: "done", result });
      return result;
    } finally { speedAbort = null; }
  }
  ctx.handle("speed-test", (o) => speedTest(o || {}));
  ctx.handle("speed-cancel", () => { if (speedAbort) speedAbort.abort(); return true; });
  ctx.handle("speed-history", () => prefs.speedHistory || []);

  // ---------------------------------------------------------------- ferramentas (com confirmação na tela)
  ctx.handle("flush-dns", async () => { const r = await run(exe("ipconfig.exe"), ["/flushdns"]); if (r.code) throw new Error("Não foi possível limpar o cache de DNS"); return true; });
  ctx.handle("renew-ip", async () => {
    const ov = lastOverview || await overview();
    const r = await run(exe("ipconfig.exe"), ["/renew", ...(ov.main ? [ov.main.name] : [])], { timeout: 90000 });
    if (r.code) throw new Error("O Windows não renovou o IP (pode precisar de permissão de administrador)");
    lastOverview = null;
    return true;
  });
  const SETTINGS = { network: "ms-settings:network", wifi: "ms-settings:network-wifi", location: "ms-settings:privacy-location", update: "ms-settings:delivery-optimization", adapters: "ncpa.cpl", reset: "ms-settings:network-advancedsettings" };
  ctx.handle("open-settings", (what) => {
    const t = SETTINGS[what]; if (!t) throw new Error("Configuração desconhecida");
    if (t.endsWith(".cpl")) execFile(exe("control.exe"), [t], { windowsHide: false });
    else execFile(path.join(SYS, "explorer.exe"), [t], { windowsHide: false });
    return true;
  });
  ctx.handle("prefs", (patch) => { if (patch) { prefs = { ...prefs, ...patch }; savePrefs(); } return prefs; });

  // ---------------------------------------------------------------- diagnóstico: por que a rede está lenta?
  const mbps = (bps) => Math.round((bps * 8) / 1e6 * 10) / 10;
  async function diagnose() {
    const steps = [];
    const step = (t) => { steps.push(t); ctx.emit("progress", t); };
    step("Lendo a conexão...");
    const ov = await overview();
    startLive();
    try {
      const findings = [];
      const add = (level, id, title, text, action) => findings.push({ level, id, title, text, action: action || null });
      if (!ov.main) {
        add("alto", "offline", "Sem conexão com a rede", "Nenhuma placa de rede está conectada. Confira o cabo ou conecte-se a uma rede Wi-Fi.", "wifi");
        return { score: 5, findings, overview: ov, at: Date.now() };
      }
      let sc = null;
      if (ov.wifi) { step("Procurando as redes Wi-Fi por perto..."); sc = await scan().catch(() => null); }
      step("Medindo o ping..."); const lat = await latency({ rounds: 20 });
      step("Testando o DNS..."); const dns = await dnsBench().catch(() => []);
      step("Vendo o que está usando a rede..."); const pr = await programs().catch(() => ({ programs: [], update: { jobs: 0 } }));
      const recent = live.slice(-4);
      const nowRx = recent.length ? recent.reduce((n, p) => n + p.rx, 0) / recent.length : 0;

      const gw = lat.find((x) => x.id === "gateway"), net = lat.filter((x) => x.id !== "gateway");
      const netOk = net.filter((x) => x.avg != null), netAvg = netOk.length ? Math.min(...netOk.map((x) => x.avg)) : null, netLoss = net.length ? Math.min(...net.map((x) => x.loss)) : 100;
      // internet
      if (gw && gw.loss === 100) add("alto", "gateway", "O roteador não responde", "O PC está conectado, mas o roteador não respondeu ao ping. Desligue o roteador da tomada por 30 segundos e ligue de novo.", "renew");
      else if (netLoss === 100) add("alto", "internet", "O roteador responde, mas a internet não", "A rede da sua casa está funcionando, mas não chega na internet. Reinicie o modem/roteador; se continuar, o problema é na operadora.");
      // Wi-Fi
      if (ov.wifi) {
        const w = ov.wifi;
        if (w.signal < 40) add("alto", "signal", `Sinal do Wi-Fi fraco (${w.signal}%)`, "Com sinal fraco a velocidade cai e o ping oscila. Aproxime o PC do roteador, tire obstáculos do caminho ou use um repetidor ou cabo de rede.");
        else if (w.signal < 60) add("médio", "signal", `Sinal do Wi-Fi médio (${w.signal}%)`, "Dá para usar, mas a velocidade não chega no máximo. Aproximar do roteador ou usar cabo ajuda.");
        const cur = sc && sc.current;
        if (w.band === "2.4") {
          if (cur && cur.twin && cur.twin.rssi >= -72) add("médio", "band", "Você está na faixa de 2,4 GHz, a mais lenta", `A rede "${cur.twin.ssid}" também está em ${cur.twin.band} GHz com bom sinal aqui. Conectar nela costuma ser bem mais rápido.`, "wifi");
          else add("baixo", "band", "Você está na faixa de 2,4 GHz", "Ela alcança mais longe, mas é mais lenta e mais disputada. Se o seu roteador tem 5 GHz, prefira essa rede quando estiver perto dele.");
        }
        if (cur && cur.load >= 1.5 && cur.neighbors >= 2) {
          const best = cur.best;
          const better = best && best.channel !== cur.channel && best.load < cur.load * 0.6;
          add(cur.load >= 3 ? "médio" : "baixo", "channel", `Canal ${cur.channel} disputado com ${cur.neighbors} redes vizinhas`,
            better ? `Redes no mesmo pedaço da frequência dividem o tempo de transmissão. Nas configurações do roteador, troque para o canal ${best.channel}, o mais livre agora.` : "Redes no mesmo pedaço da frequência dividem o tempo de transmissão. Os outros canais também estão cheios; a faixa de 5 GHz costuma ser mais livre.", "wifi-tab");
        }
        if (w.rx && w.rx < 100) add("médio", "rate", `Velocidade do Wi-Fi baixa (${w.rx} Mbps)`, "É a velocidade entre o PC e o roteador. Sinal fraco, faixa de 2,4 GHz ou um roteador antigo deixam ela baixa.");
        if (ov.main.adapterGen && w.gen && ov.main.adapterGen > w.gen) add("baixo", "gen", `Seu PC aceita Wi-Fi ${ov.main.adapterGen}, mas a conexão é Wi-Fi ${w.gen}`, "O roteador (ou a rede escolhida) é de uma geração mais antiga. Um roteador mais novo pode ser bem mais rápido e estável.");
        if (w.security === "Aberta") add("médio", "open", "Você está numa rede Wi-Fi aberta", "Qualquer pessoa por perto pode ver o que não é criptografado. Evite logins e use uma VPN em redes públicas.");
      } else if (ov.main.type === "ethernet" && ov.main.speed > 0 && ov.main.speed <= 100e6) {
        add("médio", "cable", `Cabo de rede limitado a ${Math.round(ov.main.speed / 1e6)} Mbps`, "A placa e o roteador aceitam mais, mas a ligação ficou em 100 Mbps. Troque o cabo (Cat5e ou melhor) ou a porta do roteador.");
      }
      // estabilidade
      if (gw && gw.avg != null) {
        if (gw.loss >= 5 || gw.avg > 40 || gw.jitter > 25) add("alto", "local", "A rede da sua casa está instável", `O ping até o roteador ficou em ${Math.round(gw.avg)} ms, com ${gw.loss}% de perda. Num Wi-Fi bom ele fica abaixo de 10 ms. Interferência, sinal fraco ou um roteador sobrecarregado causam isso.`);
        else if (gw.loss >= 2 || gw.avg > 15 || gw.jitter > 10) add("médio", "local", "O Wi-Fi oscila um pouco", `O ping até o roteador ficou em ${Math.round(gw.avg)} ms (oscilação de ${Math.round(gw.jitter)} ms). Em jogos online isso aparece como travadinhas.`);
      }
      if (netAvg != null && netLoss < 100) {
        if (netLoss >= 3) add("alto", "loss", `Perda de pacotes na internet (${netLoss}%)`, "Pacotes perdidos causam travadas em jogos e chamadas. Se a rede de casa está estável, o problema está no modem ou na operadora.");
        if (netAvg > 120) add("médio", "ping", `Ping alto até a internet (${Math.round(netAvg)} ms)`, "Acima de 100 ms jogos online e chamadas sofrem. Se o ping até o roteador está baixo, a demora vem da operadora.");
      }
      // DNS
      const own = dns.filter((d) => d.own && d.ms != null), pub = dns.filter((d) => !d.own && d.ms != null).sort((a, b) => a.ms - b.ms)[0];
      if (own.length && pub) {
        const o = Math.min(...own.map((d) => d.ms));
        if (o > 120 && pub.ms < o * 0.6) add("baixo", "dns", `O DNS da sua conexão está lento (${o} ms)`, `É ele que transforma nomes de sites em endereços. O ${pub.name} respondeu em ${pub.ms} ms; trocar o DNS nas configurações do Windows deixa os sites abrirem mais rápido.`, "network");
      }
      // quem está usando a rede
      if (pr.update && pr.update.jobs) add("médio", "update", pr.update.jobs === 1 ? "O Windows Update está baixando 1 arquivo" : `O Windows Update está baixando ${pr.update.jobs} arquivos`, "Downloads de atualizações usam a internet em segundo plano. Espere terminar ou pause as atualizações por um tempo nas configurações do Windows.", "update");
      if (pr.update && pr.update.mode === 3) add("baixo", "doup", "O Windows envia atualizações para outros PCs da internet", "A Otimização de Entrega está ligada para PCs da internet e usa o seu upload. Dá para deixar só para a rede local.", "update");
      const progs = pr.programs || [];
      const torrent = progs.filter((p) => p.kind && p.kind.id === "torrent");
      if (torrent.length) add("alto", "torrent", `Programa de torrent aberto: ${torrent.map((p) => p.desc || p.name).join(", ")}`, "Torrents abrem centenas de conexões e ocupam o download e o upload. Pause os downloads ou feche o programa enquanto joga ou faz chamadas.", "usage");
      if (ov.vpn.length) add("baixo", "vpn", "VPN ligada", "A VPN passa tudo por outro servidor, o que aumenta o ping e pode diminuir a velocidade.");
      // lojas de jogos e nuvem ficam conectadas o tempo todo: só viram suspeitas quando a rede está ocupada
      if (nowRx * 8 > 5e6) {
        const sus = progs.filter((p) => p.kind && ["cloud", "games", "update"].includes(p.kind.id) && p.est >= 2).slice(0, 4).map((p) => p.desc || p.name);
        add(nowRx * 8 > 30e6 ? "médio" : "baixo", "busy", `A rede está sendo usada agora (${mbps(nowRx)} Mbps baixando)`,
          sus.length ? `Algo está baixando neste momento. Prováveis: ${sus.join(", ")}. Veja na aba Uso quais programas estão conectados.` : "Algo está baixando neste momento. Veja na aba Uso quais programas estão conectados.", "usage");
      }

      const weights = { alto: 25, "médio": 12, baixo: 4 };
      const score = Math.max(5, Math.min(100, 100 - findings.reduce((n, f) => n + (weights[f.level] || 0), 0)));
      const order = { alto: 0, "médio": 1, baixo: 2 };
      findings.sort((a, b) => order[a.level] - order[b.level]);
      const result = { score, findings, overview: ov, latency: lat, dns, scan: sc && { current: sc.current, bands: sc.bands, blocked: sc.blocked }, update: pr.update, nowRx, at: Date.now() };
      ctx.emit("diagnosis", result);
      return result;
    } finally { stopLive(false); }
  }
  let diagRun = null;
  ctx.handle("diagnose", () => (diagRun = diagRun || diagnose().finally(() => { diagRun = null; })));

  // ---------------------------------------------------------------- ferramentas da IA (module.json "tools")
  ctx.handle("tool:network_status", async () => {
    const ov = await overview();
    return { connected: !!ov.main, internet: ov.internet, connection: ov.main && { type: ov.main.type, adapter: ov.main.description, link_mbps: ov.main.speed > 0 ? Math.round(ov.main.speed / 1e6) : null, ip: ov.main.ipv4.map((x) => x.ip), gateway: ov.main.gateway, dns: ov.main.dns },
      wifi: ov.wifi && { network: ov.wifi.ssid, band_ghz: ov.wifi.band, channel: ov.wifi.channel, signal_percent: ov.wifi.signal, rssi_dbm: ov.wifi.rssi, link_rate_mbps: ov.wifi.rx, wifi_generation: ov.wifi.gen, security: ov.wifi.security }, vpn: ov.vpn };
  });
  ctx.handle("tool:network_diagnose", async () => {
    const d = await (diagRun = diagRun || diagnose().finally(() => { diagRun = null; }));
    return { score: d.score, problems: d.findings.map((f) => ({ level: f.level, title: f.title, advice: f.text })),
      ping: d.latency.map((l) => ({ target: l.id, ip: l.ip, avg_ms: l.avg, jitter_ms: l.jitter, loss_percent: l.loss })), dns: d.dns.map((x) => ({ server: x.ip, name: x.name, ms: x.ms, yours: !!x.own })) };
  });
  ctx.handle("tool:wifi_networks", async () => {
    const s = await scan();
    if (s.blocked) return { error: "O Windows bloqueou a lista de redes: ative a Localização (Configurações > Privacidade > Localização)." };
    return { current: s.current && { network: s.current.ssid, band_ghz: s.current.band, channel: s.current.channel, width_mhz: s.current.width, neighbors_on_channel: s.current.neighbors, suggested_channel: s.current.best && s.current.best.channel },
      networks: s.list.slice(0, 40).map((n) => ({ name: n.ssid || "(oculta)", band_ghz: n.band, channel: n.channel, frequency_mhz: n.freq, width_mhz: n.width, signal_dbm: n.rssi, wifi_generation: n.standard || null, security: n.security })) };
  });
  ctx.handle("tool:speed_test", async () => {
    if (await ctx.host.messageBox({ message: "A IA quer testar a velocidade da internet", detail: "O teste baixa e envia dados por uns 15 segundos usando os servidores da Cloudflare.", buttons: ["Testar", "Cancelar"] }) !== 0) throw new Error("A pessoa não autorizou o teste");
    const r = await speedTest({ seconds: 8 });
    return { download_mbps: r.down, upload_mbps: r.up, ping_ms: r.ping, server: r.server };
  });
};
