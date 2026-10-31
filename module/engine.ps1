# Piphin Rede · motor: um PowerShell que fica aberto e responde pedidos (uma linha JSON por pedido, uma por resposta).
# Wi-Fi pela API do Windows (wlanapi.dll), que funciona em qualquer idioma do Windows (o netsh muda com o idioma).
# Só lê: nada aqui muda a rede.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class PwIface { public string Guid { get; set; } public string Description { get; set; } public int State { get; set; } }
public class PwConn {
  public string Guid { get; set; } public int State { get; set; } public string Profile { get; set; } public string Ssid { get; set; } public string Bssid { get; set; }
  public int Phy { get; set; } public int Signal { get; set; } public long RxKbps { get; set; } public long TxKbps { get; set; } public bool Secured { get; set; }
  public int Auth { get; set; } public int Cipher { get; set; } public int Channel { get; set; } public int Rssi { get; set; }
}
public class PwBss {
  public string Ssid { get; set; } public string Bssid { get; set; } public int Phy { get; set; } public int Rssi { get; set; } public int Quality { get; set; }
  public int FreqMhz { get; set; } public int Width { get; set; } public string Standard { get; set; } public string Security { get; set; }
}

public static class PiphinWlan {
  [DllImport("wlanapi.dll")] static extern int WlanOpenHandle(uint ver, IntPtr res, out uint neg, out IntPtr h);
  [DllImport("wlanapi.dll")] static extern int WlanCloseHandle(IntPtr h, IntPtr res);
  [DllImport("wlanapi.dll")] static extern int WlanEnumInterfaces(IntPtr h, IntPtr res, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern int WlanQueryInterface(IntPtr h, ref Guid g, int op, IntPtr res, out int size, out IntPtr data, IntPtr opType);
  [DllImport("wlanapi.dll")] static extern int WlanGetNetworkBssList(IntPtr h, ref Guid g, IntPtr ssid, int bssType, bool secOnly, IntPtr res, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern int WlanScan(IntPtr h, ref Guid g, IntPtr ssid, IntPtr ie, IntPtr res);
  [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr p);

  public static int LastError = 0;
  static IntPtr Open() { uint neg; IntPtr h; int r = WlanOpenHandle(2, IntPtr.Zero, out neg, out h); if (r != 0) { LastError = r; return IntPtr.Zero; } return h; }
  static string Mac(byte[] b, int o) { return string.Format("{0:x2}:{1:x2}:{2:x2}:{3:x2}:{4:x2}:{5:x2}", b[o], b[o+1], b[o+2], b[o+3], b[o+4], b[o+5]); }
  static string Ssid(byte[] b, int o) { int n = Math.Min(32, BitConverter.ToInt32(b, o)); return n <= 0 ? "" : Encoding.UTF8.GetString(b, o + 4, n); }

  public static List<PwIface> Interfaces() {
    var res = new List<PwIface>(); IntPtr h = Open(); if (h == IntPtr.Zero) return res;
    try {
      IntPtr list; if (WlanEnumInterfaces(h, IntPtr.Zero, out list) != 0) return res;
      int n = Marshal.ReadInt32(list);
      for (int i = 0; i < n; i++) {
        IntPtr it = new IntPtr(list.ToInt64() + 8 + i * 532);
        byte[] g = new byte[16]; Marshal.Copy(it, g, 0, 16);
        res.Add(new PwIface { Guid = new Guid(g).ToString(), Description = Marshal.PtrToStringUni(new IntPtr(it.ToInt64() + 16)), State = Marshal.ReadInt32(it, 528) });
      }
      WlanFreeMemory(list);
    } finally { WlanCloseHandle(h, IntPtr.Zero); }
    return res;
  }

  // conexão atual de cada placa conectada (wlan_intf_opcode_current_connection = 7, channel_number = 8, rssi = 0x10000102)
  public static List<PwConn> Connections() {
    var res = new List<PwConn>(); IntPtr h = Open(); if (h == IntPtr.Zero) return res;
    try {
      foreach (var f in Interfaces()) {
        if (f.State != 1) continue;
        Guid g = new Guid(f.Guid); int size; IntPtr data;
        if (WlanQueryInterface(h, ref g, 7, IntPtr.Zero, out size, out data, IntPtr.Zero) != 0) continue;
        byte[] b = new byte[size]; Marshal.Copy(data, b, 0, size); WlanFreeMemory(data);
        var c = new PwConn { Guid = f.Guid, State = BitConverter.ToInt32(b, 0), Profile = Encoding.Unicode.GetString(b, 8, 512).TrimEnd('\0'),
          Ssid = Ssid(b, 520), Bssid = Mac(b, 560), Phy = BitConverter.ToInt32(b, 568), Signal = BitConverter.ToInt32(b, 576),
          RxKbps = BitConverter.ToUInt32(b, 580), TxKbps = BitConverter.ToUInt32(b, 584), Secured = BitConverter.ToInt32(b, 588) != 0,
          Auth = BitConverter.ToInt32(b, 596), Cipher = BitConverter.ToInt32(b, 600) };
        int p = c.Profile.IndexOf('\0'); if (p >= 0) c.Profile = c.Profile.Substring(0, p);
        if (WlanQueryInterface(h, ref g, 8, IntPtr.Zero, out size, out data, IntPtr.Zero) == 0) { c.Channel = Marshal.ReadInt32(data); WlanFreeMemory(data); }
        if (WlanQueryInterface(h, ref g, 0x10000102, IntPtr.Zero, out size, out data, IntPtr.Zero) == 0) { c.Rssi = Marshal.ReadInt32(data); WlanFreeMemory(data); }
        res.Add(c);
      }
    } finally { WlanCloseHandle(h, IntPtr.Zero); }
    return res;
  }

  // pede uma busca nova de redes (a resposta chega em ~4 s)
  public static int Scan() {
    IntPtr h = Open(); if (h == IntPtr.Zero) return LastError; int r = 0;
    try { foreach (var f in Interfaces()) { Guid g = new Guid(f.Guid); int x = WlanScan(h, ref g, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero); if (x != 0) r = x; } }
    finally { WlanCloseHandle(h, IntPtr.Zero); }
    return r;
  }

  // redes por perto (cada roteador/BSSID), com frequência, largura do canal, padrão Wi-Fi e segurança tirados dos "information elements"
  public static List<PwBss> Networks() {
    var res = new List<PwBss>(); var seen = new HashSet<string>(); LastError = 0;
    IntPtr h = Open(); if (h == IntPtr.Zero) return res;
    try {
      foreach (var f in Interfaces()) {
        Guid g = new Guid(f.Guid); IntPtr list;
        int r = WlanGetNetworkBssList(h, ref g, IntPtr.Zero, 3, false, IntPtr.Zero, out list);
        if (r != 0) { LastError = r; continue; }
        int total = Marshal.ReadInt32(list), n = Marshal.ReadInt32(list, 4);
        byte[] all = new byte[total]; Marshal.Copy(list, all, 0, total); WlanFreeMemory(list);
        for (int i = 0; i < n; i++) {
          int o = 8 + i * 360;
          string bssid = Mac(all, o + 40);
          if (!seen.Add(bssid)) continue;
          int ieOff = BitConverter.ToInt32(all, o + 352), ieSize = BitConverter.ToInt32(all, o + 356);
          var e = new PwBss { Ssid = Ssid(all, o), Bssid = bssid, Phy = BitConverter.ToInt32(all, o + 52), Rssi = BitConverter.ToInt32(all, o + 56),
            Quality = BitConverter.ToInt32(all, o + 60), FreqMhz = BitConverter.ToInt32(all, o + 92) / 1000 };
          ushort cap = BitConverter.ToUInt16(all, o + 88);
          ParseIes(all, o + ieOff, ieSize, (cap & 0x10) != 0, e);
          res.Add(e);
        }
      }
    } finally { WlanCloseHandle(h, IntPtr.Zero); }
    return res;
  }

  static void ParseIes(byte[] b, int start, int size, bool privacy, PwBss e) {
    int width = 20; bool ht = false, vht = false, he = false, eht = false, rsn = false, wpa = false, sae = false, psk = false, owe = false;
    int end = Math.Min(b.Length, start + size);
    for (int p = start; p + 2 <= end; ) {
      int id = b[p], len = b[p + 1], d = p + 2;
      if (d + len > end) break;
      if (id == 45) ht = true;
      if (id == 61 && len >= 2 && (b[d + 1] & 0x04) != 0) width = Math.Max(width, 40);
      if (id == 191) vht = true;
      if (id == 192 && len >= 3) {
        if (b[d] >= 1) { width = Math.Max(width, 80); int s0 = b[d + 1], s1 = b[d + 2]; if (s1 != 0 && Math.Abs(s1 - s0) == 8) width = 160; if (b[d] == 2) width = 160; }
      }
      if (id == 255 && len >= 1) {
        int ext = b[d];
        if (ext == 35) he = true;
        if (ext == 108) eht = true;
        // HE operation com informação de 6 GHz: largura do canal nos bits 0-1 do campo "control"
        if (ext == 36 && len >= 7) {
          int info = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16);
          bool vhtInfo = (info & (1 << 14)) != 0, coHosted = (info & (1 << 15)) != 0, sixG = (info & (1 << 17)) != 0;
          int q = d + 7 + (vhtInfo ? 3 : 0) + (coHosted ? 1 : 0);
          if (sixG && q + 1 < d + len) { int w = b[q + 1] & 0x03; width = Math.Max(width, w == 3 ? 160 : w == 2 ? 80 : w == 1 ? 40 : 20); }
        }
        // EHT operation (Wi-Fi 7): 320 MHz
        if (ext == 106 && len >= 3 && (b[d + 1] & 0x01) != 0 && (b[d + 2] & 0x07) == 4) width = 320;
      }
      if (id == 48 && len >= 8) {
        rsn = true;
        int q = d + 2 + 4; int pc = b[q] | (b[q + 1] << 8); q += 2 + pc * 4;
        if (q + 2 <= d + len) { int ac = b[q] | (b[q + 1] << 8); q += 2;
          for (int k = 0; k < ac && q + 4 <= d + len; k++, q += 4) { int t = b[q + 3]; if (b[q] == 0 && b[q + 1] == 0x0f && b[q + 2] == 0xac) { if (t == 8 || t == 24) sae = true; else if (t == 2 || t == 6) psk = true; else if (t == 18) owe = true; } } }
      }
      if (id == 221 && len >= 4 && b[d] == 0x00 && b[d + 1] == 0x50 && b[d + 2] == 0xf2 && b[d + 3] == 0x01) wpa = true;
      p = d + len;
    }
    e.Width = width;
    e.Standard = eht ? "7" : he ? "6" : vht ? "5" : ht ? "4" : "";
    e.Security = sae && psk ? "WPA2/WPA3" : sae ? "WPA3" : owe ? "OWE" : rsn && psk ? "WPA2" : rsn ? "WPA2-Enterprise" : wpa ? "WPA" : privacy ? "WEP" : "open";
  }
}
'@

function Wifi {
  $ifs = [PiphinWlan]::Interfaces()
  @{ interfaces = @($ifs); connections = @([PiphinWlan]::Connections()) }
}
function Bss { $n = [PiphinWlan]::Networks(); @{ error = [PiphinWlan]::LastError; networks = @($n) } }

# placas de rede (.NET: rápido e igual em qualquer idioma)
function Info {
  $out = @()
  foreach ($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($n.NetworkInterfaceType -eq 'Loopback') { continue }
    $p = $n.GetIPProperties()
    $v4 = $null; try { $v4 = $p.GetIPv4Properties() } catch {}
    $out += [ordered]@{
      id = $n.Id; name = $n.Name; description = $n.Description; type = [string]$n.NetworkInterfaceType; up = ($n.OperationalStatus -eq 'Up')
      speed = $n.Speed; mac = (($n.GetPhysicalAddress().GetAddressBytes() | ForEach-Object { $_.ToString('x2') }) -join ':')
      ipv4 = @($p.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object { @{ ip = $_.Address.ToString(); prefix = $_.PrefixLength } })
      ipv6 = @($p.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetworkV6' -and -not $_.Address.IsIPv6LinkLocal } | ForEach-Object { $_.Address.ToString() })
      gateways = @($p.GatewayAddresses | ForEach-Object { $_.Address.ToString() } | Where-Object { $_ -ne '0.0.0.0' -and $_ -notmatch '^fe80' })
      gateways6 = @($p.GatewayAddresses | ForEach-Object { $_.Address.ToString() } | Where-Object { $_ -match ':' })
      dns = @($p.DnsAddresses | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch '^fec0' })
      dhcp = [bool]($v4 -and $v4.IsDhcpEnabled); mtu = $(if ($v4) { $v4.Mtu } else { 0 })
    }
  }
  $profiles = @()
  try { $profiles = @(Get-NetConnectionProfile | ForEach-Object { @{ alias = $_.InterfaceAlias; name = $_.Name; category = [int]$_.NetworkCategory; v4 = [int]$_.IPv4Connectivity; v6 = [int]$_.IPv6Connectivity } }) } catch {}
  @{ adapters = $out; profiles = $profiles }
}

# bytes recebidos/enviados de cada placa ligada
function Stats {
  $t = [DateTime]::UtcNow
  @{ at = [long]($t - [DateTime]'1970-01-01').TotalMilliseconds; list = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } | ForEach-Object {
    $s = $_.GetIPStatistics(); @{ id = $_.Id; rx = $s.BytesReceived; tx = $s.BytesSent } }) }
}

# programas usando a rede: conexões TCP abertas e portas UDP por processo
function Conns {
  $tcp = @(Get-NetTCPConnection -ErrorAction SilentlyContinue)
  $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)
  $by = @{}
  foreach ($c in $tcp) {
    $k = [int]$c.OwningProcess; if (-not $by.ContainsKey($k)) { $by[$k] = @{ pid = $k; est = 0; listen = 0; udp = 0; remotes = @{} } }
    $st = [int]$c.State
    if ($st -eq 5) { $by[$k].est++; if ($c.RemoteAddress -notmatch '^(127\.|::1$|0\.0\.0\.0)') { $by[$k].remotes[$c.RemoteAddress] = 1 } }
    elseif ($st -eq 2) { $by[$k].listen++ }
  }
  foreach ($u in $udp) { $k = [int]$u.OwningProcess; if (-not $by.ContainsKey($k)) { $by[$k] = @{ pid = $k; est = 0; listen = 0; udp = 0; remotes = @{} } }; $by[$k].udp++ }
  $procs = @{}; foreach ($p in Get-Process -ErrorAction SilentlyContinue) { $procs[[int]$p.Id] = $p }
  $out = @()
  foreach ($e in $by.Values) {
    if ($e.pid -le 4) { continue }
    $p = $procs[$e.pid]; $desc = ''; $path = ''
    if ($p) { try { $path = $p.Path } catch {}; try { $desc = $p.MainModule.FileVersionInfo.FileDescription } catch {} }
    $out += @{ pid = $e.pid; name = $(if ($p) { $p.ProcessName } else { '' }); desc = $desc; path = $path; est = $e.est; listen = $e.listen; udp = $e.udp; remotes = $e.remotes.Count }
  }
  @{ list = $out }
}

# aparelhos na rede (tabela ARP do Windows)
function Neighbors($a) {
  @{ list = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
      $_.State -in 'Reachable', 'Stale', 'Delay', 'Probe', 'Permanent' -and $_.LinkLayerAddress -and $_.LinkLayerAddress -notmatch '^(00-00-00-00-00-00|FF-FF-FF-FF-FF-FF|01-00-5E)' -and $_.IPAddress -notmatch '^(22[4-9]|23\d|255)\.' -and $_.IPAddress -notmatch '\.255$'
    } | ForEach-Object { @{ ip = $_.IPAddress; mac = $_.LinkLayerAddress.ToLower().Replace('-', ':'); state = [string]$_.State; ifIndex = $_.InterfaceIndex } }) }
}

# nomes dos aparelhos (DNS reverso, com limite de tempo)
function Names($a) {
  $tasks = @{}
  foreach ($ip in $a.ips) { try { $tasks[$ip] = [Net.Dns]::GetHostEntryAsync($ip) } catch {} }
  try { [Threading.Tasks.Task]::WaitAll(@($tasks.Values), 2500) | Out-Null } catch {}
  $out = @{}
  foreach ($k in $tasks.Keys) { $t = $tasks[$k]; if ($t.Status -eq 'RanToCompletion' -and $t.Result.HostName -and $t.Result.HostName -ne $k) { $out[$k] = $t.Result.HostName } }
  $out
}

# downloads do Windows Update e da Microsoft Store (Otimização de Entrega)
function DeliveryOpt {
  $jobs = @(); $mode = $null
  # só o que está baixando agora ("Caching" são arquivos já guardados); o endereço do arquivo não sai daqui
  try { $jobs = @(Get-DeliveryOptimizationStatus -ErrorAction Stop | Where-Object { [string]$_.Status -eq 'Downloading' } | ForEach-Object {
      @{ size = [long]$_.FileSize; done = [long]$_.TotalBytesDownloaded; peers = [long]$_.BytesFromPeers } }) } catch {}
  try { $mode = [int](Get-DOConfig -ErrorAction Stop).DownloadMode } catch {}
  @{ jobs = $jobs; mode = $mode }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $data = switch ($req.cmd) {
      'wifi' { Wifi } 'scan' { @{ code = [PiphinWlan]::Scan() } } 'bss' { Bss } 'info' { Info } 'stats' { Stats } 'conns' { Conns }
      'neighbors' { Neighbors $req.a } 'names' { Names $req.a } 'do' { DeliveryOpt } 'ping' { @{ pong = $true } }
      default { throw "comando desconhecido: $($req.cmd)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; data = $data } | ConvertTo-Json -Depth 6 -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
  [Console]::Out.Flush()
}
