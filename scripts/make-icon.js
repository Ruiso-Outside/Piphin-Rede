// Desenha o ícone do Piphin Rede: icons/rede.png (256). Uso: npm run icon (usa o Electron do Piphin Hub).
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL("about:blank");
  const b64 = await win.webContents.executeJavaScript(`(() => {
    const s = 256, c = document.createElement("canvas"); c.width = c.height = s;
    const g = c.getContext("2d");
    g.beginPath(); g.roundRect(8, 8, 240, 240, 56);
    const bg = g.createLinearGradient(0, 0, s, s); bg.addColorStop(0, "#06302d"); bg.addColorStop(1, "#0b0a12");
    g.fillStyle = bg; g.fill();
    g.lineWidth = 3; g.strokeStyle = "rgba(20,184,166,.6)"; g.stroke();
    const grad = g.createLinearGradient(40, 200, 216, 40); grad.addColorStop(0, "#0d9488"); grad.addColorStop(.55, "#14b8a6"); grad.addColorStop(1, "#38bdf8");
    // ondas do Wi-Fi
    g.save(); g.shadowColor = "#14b8a6"; g.shadowBlur = 18; g.lineCap = "round"; g.strokeStyle = grad;
    for (const [r, w] of [[112, 20], [78, 20], [44, 20]]) { g.lineWidth = w; g.beginPath(); g.arc(128, 176, r, Math.PI * 1.22, Math.PI * 1.78); g.stroke(); }
    g.fillStyle = "#5eead4"; g.beginPath(); g.arc(128, 176, 15, 0, Math.PI * 2); g.fill(); g.restore();
    // pulso de sinal embaixo
    g.save(); g.strokeStyle = "#e0f2fe"; g.lineWidth = 7; g.lineJoin = "round"; g.lineCap = "round"; g.shadowColor = "#38bdf8"; g.shadowBlur = 10;
    g.beginPath(); g.moveTo(52, 214); g.lineTo(96, 214); g.lineTo(110, 194); g.lineTo(128, 232); g.lineTo(146, 204); g.lineTo(158, 214); g.lineTo(204, 214); g.stroke(); g.restore();
    return c.toDataURL("image/png").split(",")[1];
  })()`);
  fs.mkdirSync(path.join(__dirname, "..", "icons"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "icons", "rede.png"), Buffer.from(b64, "base64"));
  console.log("ícone: icons/rede.png");
  app.quit();
});
