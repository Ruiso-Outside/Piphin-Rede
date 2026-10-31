# Piphin Rede

Gerenciador de rede, módulo do [Piphin Hub](https://github.com/Ruiso-Outside/Piphin-Hub). Mostra tudo da sua conexão e explica em linguagem simples o que pode estar deixando a internet lenta.

- **Visão geral**: tipo de conexão, sinal, velocidade do Wi-Fi, IP, roteador, DNS, VPN e o **diagnóstico** com nota de 0 a 100 e o que fazer em cada problema
- **Wi-Fi**: sinal em % e dBm, faixa (2,4 / 5 / 6 GHz), canal, frequência, largura do canal (20 a 320 MHz), geração do Wi-Fi e segurança; gráfico das **frequências** com todas as redes vizinhas, ocupação de cada canal e o **canal mais livre** para configurar no roteador
- **Uso**: download e upload ao vivo (últimos 2 minutos), programas conectados e downloads do Windows Update
- **Aparelhos**: celulares, PCs, TVs e outros aparelhos da rede, com nome, IP, MAC e endereço privado; dá para dar nomes a eles
- **Testes**: velocidade da internet (servidores da Cloudflare, só quando você clica), ping e oscilação até o roteador e a internet, rapidez do DNS
- **Ferramentas**: limpar o cache de DNS, renovar o IP, atalhos para as configurações de rede do Windows
- **IA**: com o Piphin LLM, a IA vê a conexão, faz o diagnóstico, lista as redes Wi-Fi e testa a velocidade (ferramentas no `module/module.json`)

O diagnóstico olha: sinal fraco, faixa de 2,4 GHz quando há 5 GHz, canal disputado com vizinhos, velocidade do Wi-Fi baixa, roteador de geração mais antiga que o PC, rede aberta, cabo limitado a 100 Mbps, ping e perda até o roteador e a internet, DNS lento, Windows Update baixando, Otimização de Entrega enviando para a internet, torrent aberto, VPN e uso alto no momento.

Só lê a rede e funciona sem administrador. O Wi-Fi usa a API do Windows (`wlanapi.dll`), igual em qualquer idioma do Windows. No Windows 11 24H2 ou mais novo, a lista de redes por perto precisa da Localização ligada (o módulo avisa e abre a configuração).

## Estrutura

- `module/`: `module.json` (manifesto e ferramentas da IA), `backend.js` (testes, diagnóstico, uso ao vivo), `wifi.js` (canais, frequências e congestionamento) e `engine.ps1` (PowerShell que fica aberto e lê o Wi-Fi, as placas, as conexões e os aparelhos)
- `web/`: a tela (`index.html`, `style.css`, `icons.css`, `js/app.js`)
- `scripts/`: `make-module.js` (gera `dist/piphin-module-rede-<versão>.zip`), `make-icons.js` (ícones Lucide), `make-icon.js` (ícone do módulo)

```
npm run module
```
