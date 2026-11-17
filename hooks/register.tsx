import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Aba, Comando, Container, Grupo, Leitura, Mcp, Situacao } from '../types'

// Um painel só, com duas abas desenhadas por nós no topo: os comandos de terminal
// que o Claude roda e o que está rodando do projeto na máquina.
const PAINEL = 'ide-vibe-panel'
const TITULO = 'IDE Vibe Panel'

// A partir desta largura (em colunas) as duas partes ficam lado a lado.
const LARGURA_LADO_A_LADO = 70

const aba = atom({ plugin: 'ide-vibe-panel', key: 'aba' } as const, 'comandos' as Aba)

// ─────────────────────────────── Comandos ───────────────────────────────

const LIMITE = 200

const comandos = atom({ plugin: 'ide-vibe-panel', key: 'comandos' } as const, [], {
  shape: 'comandos-1',
})

const ROTULO: Record<Situacao, string> = {
  rodando: '▶ rodando',
  'segundo-plano': '◷ 2º plano',
  ok: '✓ ok',
  falhou: '✗ falhou',
  interrompido: '■ parado',
  negado: '⊘ negado',
}

const COR: Record<Situacao, string | undefined> = {
  rodando: 'yellow',
  'segundo-plano': 'cyan',
  ok: 'green',
  falhou: 'red',
  interrompido: 'red',
  negado: 'gray',
}

function umaLinha(texto: string, max: number): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo
}

function duracao(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

async function registrar(
  $: EngineInterface,
  id: string,
  ferramenta: 'Bash' | 'PowerShell',
  comando: string,
  descricao: string,
  segundoPlano: boolean,
) {
  const inicio = await $.clock.now()
  const novo: Comando = {
    id,
    ferramenta,
    comando,
    descricao,
    situacao: 'rodando',
    inicio,
    duracaoMs: null,
    tarefaId: null,
  }
  await update($, comandos, lista => [...lista, novo].slice(-LIMITE))
  if (!segundoPlano) $.ui.status(`Rodando: ${umaLinha(comando, 120)}`)

  return inicio
}

async function concluir($: EngineInterface, id: string, inicio: number, ran: ToolCallResult) {
  const fim = await $.clock.now()
  let situacao: Situacao
  let tarefaId: string | null = null
  if (ran.deny !== undefined) {
    situacao = 'negado'
  } else {
    const r = ran.result as { interrupted?: boolean; backgroundTaskId?: string } | undefined
    if (r?.backgroundTaskId) {
      situacao = 'segundo-plano'
      tarefaId = r.backgroundTaskId
    } else if (r?.interrupted) {
      situacao = 'interrompido'
    } else {
      situacao = ran.isError ? 'falhou' : 'ok'
    }
  }
  await update($, comandos, lista =>
    lista.map(c =>
      c.id === id
        ? { ...c, situacao, tarefaId, duracaoMs: situacao === 'segundo-plano' ? null : fim - inicio }
        : c,
    ),
  )
  const aindaRodando = (await read($, comandos)).some(c => c.situacao === 'rodando')
  if (!aindaRodando) $.ui.status(undefined)
}

// ─────────────────────────────── Ambiente ───────────────────────────────

const PERIODO_MS = 10_000
// Backend que acabou de subir ainda está compilando: só depois disto "sem porta" vira aviso.
const CARENCIA_DA_PORTA_S = 120

const leitura = atom({ plugin: 'ide-vibe-panel', key: 'leitura' } as const, null, {
  shape: 'leitura-2',
})
const confirmando = atom({ plugin: 'ide-vibe-panel', key: 'confirmando' } as const, null)

// O script que lê a máquina: processos node e flyctl cujo comando cita a pasta do
// projeto (subindo pelos invólucros do npm), as portas que cada árvore escuta e os
// containers do Docker Compose cuja pasta de trabalho é a do projeto. A raiz chega
// pela variável AMB_ROOT, e o script vai codificado (-EncodedCommand), sem aspas a escapar.
const SONDA = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = ([string]$env:AMB_ROOT).TrimEnd('\', '/').ToLower()
$agora = Get-Date
$todos = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, CreationDate)
$porId = @{}
$filhos = @{}
foreach ($p in $todos) {
  $id = [int]$p.ProcessId
  $porId[$id] = $p
  $pai = [int]$p.ParentProcessId
  if ($pai -ne $id) {
    if (-not $filhos.ContainsKey($pai)) { $filhos[$pai] = New-Object System.Collections.ArrayList }
    [void]$filhos[$pai].Add($id)
  }
}
function Ehdoprojeto($p) {
  $cl = ([string]$p.CommandLine).ToLower()
  if ($p.Name -eq 'flyctl.exe') { return $true }
  return ($p.Name -eq 'node.exe' -and $cl.Contains($root) -and -not ($cl -match 'claude|extensionhost'))
}
function Envolve($p) {
  $cl = ([string]$p.CommandLine).ToLower()
  if ($cl -match 'claude|extensionhost|code\.exe') { return $false }
  if ($p.Name -eq 'node.exe') { return ($cl -match 'npm-cli|npx-cli' -or $cl.Contains($root)) }
  if ($p.Name -eq 'cmd.exe') { return ($cl -match '\bnpm\b|\bnpx\b|node|/d /s /c') }
  return $false
}
$raizes = @{}
foreach ($p in $todos) {
  if (-not (Ehdoprojeto $p)) { continue }
  $atual = [int]$p.ProcessId
  for ($i = 0; $i -lt 12; $i++) {
    $ppid = [int]$porId[$atual].ParentProcessId
    $pp = $porId[$ppid]
    if (-not $pp -or $ppid -eq $atual) { break }
    if ((Ehdoprojeto $pp) -or (Envolve $pp)) { $atual = $ppid } else { break }
  }
  $raizes[$atual] = $true
}
function Descendentes($id) {
  $lista = New-Object System.Collections.ArrayList
  $fila = New-Object System.Collections.Queue
  $fila.Enqueue($id)
  while ($fila.Count -gt 0) {
    $x = $fila.Dequeue()
    if ($lista.Contains($x)) { continue }
    [void]$lista.Add($x)
    if ($filhos.ContainsKey($x)) { foreach ($f in $filhos[$x]) { $fila.Enqueue($f) } }
  }
  return ,$lista
}
$arvores = @{}
foreach ($r in $raizes.Keys) { $arvores[$r] = Descendentes $r }
$escuta = @{}
foreach ($c in @(Get-NetTCPConnection -State Listen)) {
  $o = [int]$c.OwningProcess
  if (-not $escuta.ContainsKey($o)) { $escuta[$o] = New-Object System.Collections.ArrayList }
  if (-not $escuta[$o].Contains([int]$c.LocalPort)) { [void]$escuta[$o].Add([int]$c.LocalPort) }
}
$grupos = @()
foreach ($r in $raizes.Keys) {
  $dentroDeOutra = $false
  foreach ($o in $raizes.Keys) { if ($o -ne $r -and $arvores[$o].Contains($r)) { $dentroDeOutra = $true } }
  if ($dentroDeOutra) { continue }
  $mem = 0
  $cmds = New-Object System.Collections.ArrayList
  $portas = New-Object System.Collections.ArrayList
  foreach ($x in $arvores[$r]) {
    $p = $porId[$x]
    if (-not $p) { continue }
    $mem += [int64]$p.WorkingSetSize
    if ($p.CommandLine) { [void]$cmds.Add([string]$p.CommandLine) }
    if ($escuta.ContainsKey($x)) { foreach ($pt in $escuta[$x]) { if (-not $portas.Contains($pt)) { [void]$portas.Add($pt) } } }
  }
  $raiz = $porId[$r]
  $texto = ($cmds -join ' || ')
  if ($texto.Length -gt 4000) { $texto = $texto.Substring(0, 4000) }
  $grupos += [pscustomobject]@{
    pid = $r
    processos = $arvores[$r].Count
    mb = [int]($mem / 1MB)
    inicio = $raiz.CreationDate.ToString('dd\/MM HH:mm')
    idadeS = [int]($agora - $raiz.CreationDate).TotalSeconds
    portas = @($portas | Sort-Object)
    cmd = $texto
  }
}
$docker = @()
$dockerDisponivel = $false
if (Get-Command docker) {
  $linhas = @(& docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Labels}}' 2>$null)
  if ($LASTEXITCODE -eq 0) { $dockerDisponivel = $true }
  foreach ($l in $linhas) {
    $c = ([string]$l) -split '\|', 4
    if ($c.Count -lt 4) { continue }
    $m = [regex]::Match($c[3], 'com\.docker\.compose\.project\.working_dir=([^,]*)')
    if (-not $m.Success) { continue }
    $dir = $m.Groups[1].Value.TrimEnd('\', '/').ToLower()
    if (-not $dir.StartsWith($root)) { continue }
    $pts = @([regex]::Matches($c[3], 'desktop\.docker\.io/ports/[^=]+=[^:,]*:(\d+)') | ForEach-Object { $_.Groups[1].Value }) -join ' '
    $docker += [pscustomobject]@{ nome = $c[0]; estado = $c[1]; status = $c[2]; portas = $pts }
  }
}
# Servidores MCP da máquina inteira (de qualquer projeto): os filhos de uma sessão do
# Claude Code que não são o terminal das ferramentas, e os processos que se dizem MCP
# no comando (os que uma sessão fechada deixou para trás e os abertos por outro app).
$minha = 0
$x = [int]$PID
for ($i = 0; $i -lt 12; $i++) {
  $p = $porId[$x]
  if (-not $p) { break }
  if ($p.Name -eq 'claude.exe') { $minha = $x; break }
  $x = [int]$p.ParentProcessId
}
function Ehsessao($p) {
  return ($p -and $p.Name -eq 'claude.exe' -and -not ([string]$p.CommandLine).Contains('--type='))
}
function Paivivo($p) {
  $pai = $porId[[int]$p.ParentProcessId]
  if (-not $pai -or [int]$pai.ProcessId -eq [int]$p.ProcessId) { return $null }
  # PID reaproveitado: o "pai" nasceu depois do filho, então o pai de verdade morreu.
  if ($pai.CreationDate -gt $p.CreationDate) { return $null }
  return $pai
}
$doTerminal = @('conhost.exe', 'bash.exe', 'sh.exe', 'powershell.exe', 'pwsh.exe', 'git.exe', 'claude.exe', 'taskkill.exe', 'chcp.com')
function Ehterminal($p) {
  if (-not $p) { return $false }
  if ($doTerminal -contains ([string]$p.Name).ToLower()) { return $true }
  return ($p.Name -eq 'cmd.exe' -and ([string]$p.CommandLine) -match 'chcp|powershell\.exe|pwsh|bash\.exe')
}
$candidatos = @{}
foreach ($p in $todos) {
  if (Ehterminal $p) { continue }
  if (($agora - $p.CreationDate).TotalSeconds -lt 5) { continue }
  $pai = Paivivo $p
  if (Ehsessao $pai) { $candidatos[[int]$p.ProcessId] = $true; continue }
  if (Ehterminal $pai) { continue }
  if (([string]$p.CommandLine) -match '(?i)(^|[\\/@\s"''_-])mcp([\\/@\s"''_.-]|$)') { $candidatos[[int]$p.ProcessId] = $true }
}
$arvMcp = @{}
foreach ($r in $candidatos.Keys) { $arvMcp[$r] = Descendentes $r }
$mcp = @()
foreach ($r in $candidatos.Keys) {
  $dentroDeOutro = $false
  foreach ($o in $candidatos.Keys) { if ($o -ne $r -and $arvMcp[$o].Contains($r)) { $dentroDeOutro = $true } }
  if ($dentroDeOutro) { continue }
  $mem = 0
  $cmds = New-Object System.Collections.ArrayList
  $portas = New-Object System.Collections.ArrayList
  foreach ($x in $arvMcp[$r]) {
    $p = $porId[$x]
    if (-not $p) { continue }
    $mem += [int64]$p.WorkingSetSize
    if ($p.CommandLine) { [void]$cmds.Add([string]$p.CommandLine) }
    if ($escuta.ContainsKey($x)) { foreach ($pt in $escuta[$x]) { if (-not $portas.Contains($pt)) { [void]$portas.Add($pt) } } }
  }
  $raiz = $porId[$r]
  $pai = Paivivo $raiz
  $texto = ($cmds -join ' || ')
  if ($texto.Length -gt 4000) { $texto = $texto.Substring(0, 4000) }
  $dono = 'fechada'
  $sessao = 0
  $sessaoInicio = ''
  $app = ''
  if (Ehsessao $pai) {
    $sessao = [int]$pai.ProcessId
    $sessaoInicio = $pai.CreationDate.ToString('dd\/MM HH:mm')
    if ($sessao -eq $minha) { $dono = 'esta' } else { $dono = 'outra' }
  } elseif ($pai) {
    $dono = 'app'
    $app = ([string]$pai.Name) -replace '\.exe$', ''
  }
  $mcp += [pscustomobject]@{
    pid = $r
    processos = $arvMcp[$r].Count
    mb = [int]($mem / 1MB)
    inicio = $raiz.CreationDate.ToString('dd\/MM HH:mm')
    portas = @($portas | Sort-Object)
    cmd = $texto
    dono = $dono
    sessao = $sessao
    sessaoInicio = $sessaoInicio
    app = $app
  }
}
[pscustomobject]@{
  agora = $agora.ToString('HH:mm:ss')
  grupos = @($grupos)
  docker = @($docker)
  dockerDisponivel = $dockerDisponivel
  mcp = @($mcp)
} | ConvertTo-Json -Depth 5 -Compress
`

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 do texto em UTF-16LE, que é o que o -EncodedCommand do PowerShell espera. */
function base64Utf16le(texto: string): string {
  const bytes: number[] = []
  for (let i = 0; i < texto.length; i++) {
    const c = texto.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  let saida = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    saida += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    saida += b === undefined ? '=' : B64.charAt((n >> 6) & 63)
    saida += c === undefined ? '=' : B64.charAt(n & 63)
  }
  return saida
}

const SONDA_CODIFICADA = base64Utf16le(SONDA)

function emLista<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[]
  return x === null || x === undefined ? [] : [x as T]
}

let emVoo = false

async function sondar($: EngineInterface): Promise<void> {
  if (emVoo) return
  emVoo = true
  const raiz = await $.session.cwd()
  try {
    const r = await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', SONDA_CODIFICADA],
      { env: { AMB_ROOT: raiz }, timeoutMs: 25_000 },
    )
    // Só a linha do JSON: o PowerShell pode pôr registros de progresso (CLIXML) antes.
    const texto =
      r.stdout
        .replace(/^﻿/, '')
        .split(/\r?\n/)
        .map(linha => linha.slice(Math.max(0, linha.indexOf('{"agora"'))))
        .filter(linha => linha.startsWith('{"agora"'))
        .pop() ?? ''
    if (!texto) throw new Error(r.stderr.trim().slice(0, 200) || `saída vazia (código ${r.exitCode})`)
    const bruto = JSON.parse(texto) as Record<string, unknown>
    const nova: Leitura = {
      raiz,
      agora: String(bruto.agora ?? ''),
      grupos: emLista<Grupo>(bruto.grupos).map(g => ({ ...g, portas: emLista<number>(g.portas) })),
      docker: emLista<Container>(bruto.docker),
      dockerDisponivel: bruto.dockerDisponivel === true,
      mcp: emLista<Mcp>(bruto.mcp).map(m => ({ ...m, portas: emLista<number>(m.portas) })),
      erro: null,
    }
    await update($, leitura, () => nova)
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro)
    await update($, leitura, atual =>
      atual
        ? { ...atual, erro: motivo }
        : { raiz, agora: '', grupos: [], docker: [], dockerDisponivel: false, mcp: [], erro: motivo },
    )
  } finally {
    emVoo = false
  }
}

type Tipo = { nome: string; familia: string }

/** O que é a árvore, lido dos comandos dela. A família decide o aviso de duplicado. */
function classificar(cmd: string, raiz: string): Tipo {
  const c = cmd.toLowerCase().replace(/\\+/g, '/')
  const pasta = (() => {
    const r = raiz.toLowerCase().replace(/\\+/g, '/').replace(/\/$/, '')
    const i = c.indexOf(`${r}/`)
    if (i < 0) return ''
    const seg = c.slice(i + r.length + 1).split('/')[0]
    return seg && seg !== 'node_modules' ? ` · ${seg}/` : ''
  })()
  if (c.includes('mpg proxy')) return { nome: 'Fly (proxy do banco)', familia: 'tunel' }
  if (c.includes('flyctl')) return { nome: 'Fly CLI', familia: 'fly' }
  if (c.includes('@playwright/test') || /playwright[^|]*\btest\b/.test(c))
    return { nome: `Testes e2e (Playwright)${pasta}`, familia: 'e2e' }
  if (c.includes('jest')) return { nome: `Testes (Jest)${pasta}`, familia: 'jest' }
  if (/@nestjs\/cli|nest(\.js)?"?\s+start/.test(c)) {
    const watch = c.includes('--watch') ? ', watch' : ''
    return { nome: `Backend (NestJS${watch})${pasta}`, familia: 'backend' }
  }
  if (c.includes('next/dist/bin/next') || /\bnext\s+(dev|start|build)\b/.test(c)) {
    if (/\bnext"?\s+build\b/.test(c))
      return { nome: `Build do frontend (next build)${pasta}`, familia: 'build' }
    if (/\bnext"?\s+start\b/.test(c)) return { nome: `Frontend (next start)${pasta}`, familia: 'frontend' }
    return { nome: `Frontend (next dev)${pasta}`, familia: 'frontend' }
  }
  if (c.includes('vite')) return { nome: `Frontend (Vite)${pasta}`, familia: 'frontend' }
  if (c.includes('prisma') && c.includes('studio')) return { nome: 'Prisma Studio', familia: 'prisma-studio' }
  if (c.includes('prisma')) return { nome: `Prisma${pasta}`, familia: 'prisma' }
  if (/typescript\/bin\/tsc|\btsc\b/.test(c)) return { nome: `TypeScript (tsc)${pasta}`, familia: 'tsc' }
  if (c.includes('knip') || c.includes('dependency-cruiser') || c.includes('osv-scanner'))
    return { nome: 'Portões de lint', familia: 'lint' }
  const script = /\brun\s+([\w:.-]+)/.exec(c)?.[1] ?? /node"?\s+"?([^"\s|]+)/.exec(c)?.[1]?.split('/').pop()
  return { nome: `Node${script ? ` (${script})` : ''}${pasta}`, familia: `node:${script ?? '?'}` }
}

function memoria(mb: number): string {
  if (mb < 1024) return `${mb} MB`
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
}

/** O nome do servidor MCP, lido do pacote no comando (`npx -y @playwright/mcp@latest`). */
function nomeMcp(cmd: string): string {
  const c = cmd.toLowerCase().replace(/\\+/g, '/')
  if (c.includes('@playwright/mcp')) return 'Playwright MCP'
  const pedacos = c.split(/[\s"'^|]+/).filter(Boolean)
  const pacote = pedacos.find(
    p => /^@[a-z0-9._-]+\/[a-z0-9._-]+(@[\w.-]+)?$/.test(p) || /^[a-z0-9._-]*mcp[a-z0-9._-]*(@[\w.-]+)?$/.test(p),
  )
  if (pacote) {
    const semVersao = pacote.startsWith('@') ? pacote.split('@').slice(0, 2).join('@') : pacote.split('@')[0]
    return `MCP · ${semVersao}`
  }
  const exe = /([\w.-]+?)(\.exe)?"?(\s|$)/.exec(c.split('/').pop() ?? '')?.[1]
  return `MCP${exe ? ` · ${exe}` : ''}`
}

const DONO_MCP: Record<Mcp['dono'], { cor: string; confirmar: string }> = {
  esta: { cor: 'green', confirmar: 'Confirmar: esta sessão perde as ferramentas dele' },
  outra: { cor: 'cyan', confirmar: 'Confirmar: a outra sessão perde as ferramentas dele' },
  fechada: { cor: 'red', confirmar: 'Confirmar encerramento' },
  app: { cor: 'yellow', confirmar: 'Confirmar: o programa que abriu perde o servidor' },
}

function quemAbriu(m: Mcp): string {
  if (m.dono === 'esta') return 'desta sessão'
  if (m.dono === 'outra') return `outra sessão (aberta desde ${m.sessaoInicio})`
  if (m.dono === 'app') return `aberto por ${m.app}`
  return 'sessão fechada: esquecido'
}

async function encerrar($: EngineInterface, pid: number, depois?: string): Promise<void> {
  const atual = await read($, confirmando)
  if (atual !== pid) {
    await update($, confirmando, () => pid)
    $.clock.after(6000, async () => {
      if ((await read($, confirmando)) === pid) await update($, confirmando, () => null)
    })
    return
  }
  await update($, confirmando, () => null)
  const r = await $.process.run(['taskkill', '/PID', String(pid), '/T', '/F'], { timeoutMs: 20_000 })
  $.ui.toast(
    r.exitCode === 0 ? `Processo ${pid} encerrado${depois ? `. ${depois}` : ''}` : `Não consegui encerrar o ${pid}`,
  )
  await sondar($)
}

// ─────────────────────────────── Hooks ───────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'painel',
      description: 'Abre o painel do projeto (comandos de terminal e o que está rodando na máquina)',
    })
    void $.ui.open({ id: PAINEL, title: TITULO })
    void sondar($)
    $.clock.every(PERIODO_MS, () => sondar($))

    return next(e)
  })

  on('command.run', { command: 'painel' }, async $ => {
    await $.ui.open({ id: PAINEL, title: TITULO })
    void sondar($)

    return { text: 'IDE Vibe Panel aberto.' }
  })

  // O painel só observa: uma falha dele nunca pode barrar o comando do Claude.
  // O registro e a conclusão engolem o próprio erro, e o .catch de cada hook deixa
  // o comando seguir (next) se o hook inteiro falhar ou estourar o tempo.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const inicio = await registrar(
      $,
      e.tool_use_id,
      'Bash',
      e.command,
      e.description ?? '',
      e.run_in_background === true,
    ).catch(() => null)
    const ran = await next(e)
    if (inicio !== null) await concluir($, e.tool_use_id, inicio, ran).catch(() => undefined)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const inicio = await registrar(
      $,
      e.tool_use_id,
      'PowerShell',
      e.command,
      e.description ?? '',
      e.run_in_background === true,
    ).catch(() => null)
    const ran = await next(e)
    if (inicio !== null) await concluir($, e.tool_use_id, inicio, ran).catch(() => undefined)

    return ran
  }).catch(($, e, next) => next(e))

  // Comando em 2º plano: o fim chega como notificação de tarefa, que cita o id.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification') {
      const marcarFim = async () => {
        const agora = await $.clock.now()
        const fim: Situacao = /<status>\s*(failed|error)/i.test(e.text) ? 'falhou' : 'ok'
        await update($, comandos, lista =>
          lista.map(c =>
            c.situacao === 'segundo-plano' &&
            ((c.tarefaId && e.text.includes(c.tarefaId)) || e.text.includes(c.id))
              ? { ...c, situacao: fim, duracaoMs: agora - c.inicio }
              : c,
          ),
        )
      }
      // A mensagem segue para o Claude mesmo que o painel falhe ao marcar o fim.
      await marcarFim().catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Rede de segurança: o que estava em 2º plano e saiu da lista de tarefas vivas foi fechado.
  on('classic.Stop', async ($, e, next) => {
    const vivas = e.background_tasks
    if (Array.isArray(vivas)) {
      const fecharOrfaos = async () => {
        const ids = new Set(vivas.map(t => t.id))
        const linhas = vivas.map(t => t.command ?? '').filter(Boolean)
        const viva = (c: Comando) =>
          (c.tarefaId !== null && ids.has(c.tarefaId)) ||
          linhas.some(l => l === c.comando || (l.includes('... [+') && c.comando.startsWith(l.split('... [+')[0] ?? '')))
        const lista = await read($, comandos)
        if (lista.some(c => c.situacao === 'segundo-plano' && !viva(c))) {
          const agora = await $.clock.now()
          await update($, comandos, atual =>
            atual.map(c =>
              c.situacao === 'segundo-plano' && !viva(c)
                ? { ...c, situacao: 'ok' as Situacao, duracaoMs: agora - c.inicio }
                : c,
            ),
          )
        }
      }
      // O fim do turno segue mesmo que o painel falhe ao fechar os órfãos.
      await fecharOrfaos().catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Linha de "pensando": mostra o comando em andamento no lugar da palavra animada.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.props.mode !== 'tool-use') return next(e)
    const lista = await read($, comandos)
    const atual = [...lista].reverse().find(c => c.situacao === 'rodando')
    if (!atual) return next(e)

    return next({ ...e, props: { ...e.props, message: `Rodando: ${umaLinha(atual.comando, 80)}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PAINEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const abaAtual = await read($, aba)
    const lista = await read($, comandos)
    const l = await read($, leitura)
    const pedindo = await read($, confirmando)
    const linhas = e.viewport?.rows ?? 30
    const colunas = e.viewport?.columns ?? 0
    // Com largura, os dois lado a lado; numa janela estreita, uma aba de cada vez.
    const ladoALado = colunas >= LARGURA_LADO_A_LADO
    const largura = ladoALado ? Math.floor((colunas - 3) / 2) : colunas || 80

    const rodandoCmd = lista.filter(c => c.situacao === 'rodando' || c.situacao === 'segundo-plano').length

    // ── Comandos ──
    const espaco = Math.max(1, Math.floor((linhas - 5) / 2))
    const recentes = [...lista].reverse().slice(0, espaco)
    const corpoComandos = (
      <Box flexDirection="column">
        <Text bold>
          {rodandoCmd === 0 ? 'Nada rodando agora' : `${rodandoCmd} rodando`} · {lista.length} no total
        </Text>
        {lista.length === 0 && <Text dimColor>Nenhum comando ainda.</Text>}
        {recentes.map(c => (
          <Box key={c.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color={COR[c.situacao]}>{ROTULO[c.situacao]}</Text>
              <Text dimColor>
                {' '}
                {c.ferramenta}
                {c.duracaoMs !== null ? ` · ${duracao(c.duracaoMs)}` : ''}
                {c.descricao ? ` · ${umaLinha(c.descricao, Math.max(30, largura - 20))}` : ''}
              </Text>
            </Text>
            <Text dimColor={c.situacao !== 'rodando' && c.situacao !== 'segundo-plano'}>
              {umaLinha(c.comando, Math.max(60, largura * 2))}
            </Text>
          </Box>
        ))}
      </Box>
    )

    // ── Ambiente ──
    const grupos = (l?.grupos ?? []).map(g => ({ ...g, tipo: classificar(g.cmd, l?.raiz ?? '') }))
    const porFamilia = new Map<string, number>()
    for (const g of grupos) porFamilia.set(g.tipo.familia, (porFamilia.get(g.tipo.familia) ?? 0) + 1)
    // Os esquecidos primeiro, depois os de outro programa, de outra sessão e desta.
    const ordemDono: Record<Mcp['dono'], number> = { fechada: 0, app: 1, outra: 2, esta: 3 }
    const mcps = [...(l?.mcp ?? [])].sort((a, b) => ordemDono[a.dono] - ordemDono[b.dono] || a.pid - b.pid)
    const corpoAmbiente = !l ? (
      <Text dimColor>Lendo a máquina…</Text>
    ) : (
      <Box flexDirection="column">
        <Text bold>
          {(l.raiz.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? l.raiz) + ' · '}
          {grupos.length === 0
            ? 'nenhum processo'
            : `${grupos.length} processo${grupos.length > 1 ? 's' : ''} · ${memoria(grupos.reduce((s, g) => s + g.mb, 0))}`}
        </Text>
        <Text dimColor>
          {l.docker.length > 0 ? `Docker ${l.docker.filter(c => c.estado === 'running').length}/${l.docker.length}` : ''}
          {l.docker.length > 0 && l.agora ? ' · ' : ''}
          {l.agora ? `lido às ${l.agora}` : ''}
        </Text>
        <Box marginTop={1}>
          <Button key="atualizar" dimColor onPress={() => sondar($)}>
            Atualizar
          </Button>
        </Box>
        {l.erro && <Text color="red">Falha ao ler: {l.erro}</Text>}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Processos</Text>
          {grupos.length === 0 && <Text dimColor>Nada do projeto rodando.</Text>}
          {grupos.map(g => {
            const duplicado = (porFamilia.get(g.tipo.familia) ?? 0) > 1 && g.tipo.familia !== 'fly'
            const semPorta =
              (g.tipo.familia === 'backend' || g.tipo.familia === 'frontend') &&
              g.portas.length === 0 &&
              g.idadeS > CARENCIA_DA_PORTA_S
            const cor = duplicado ? 'red' : semPorta ? 'yellow' : 'green'
            return (
              <Box key={String(g.pid)} flexDirection="column" marginTop={1}>
                <Text>
                  <Text color={cor}>● </Text>
                  <Text bold>{g.tipo.nome}</Text>
                </Text>
                <Text dimColor>
                  {g.portas.length > 0 ? `porta ${g.portas.join(', ')}` : 'sem porta'} · {memoria(g.mb)} · desde{' '}
                  {g.inicio} · PID {g.pid}
                  {g.processos > 1 ? ` (+${g.processos - 1})` : ''}
                </Text>
                {duplicado && <Text color="red">Duplicado: há mais de um rodando.</Text>}
                {semPorta && <Text color="yellow">Sem porta aberta: pode ter caído (banco parado?).</Text>}
                <Button key={`encerrar-${g.pid}`} dimColor={pedindo !== g.pid} onPress={() => encerrar($, g.pid)}>
                  {pedindo === g.pid ? 'Confirmar encerramento' : 'Encerrar'}
                </Button>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>Docker</Text>
          {!l.dockerDisponivel && <Text dimColor>Docker fora do ar ou não instalado.</Text>}
          {l.dockerDisponivel && l.docker.length === 0 && <Text dimColor>Nenhum container do projeto.</Text>}
          {l.docker.map(c => (
            <Text key={c.nome}>
              <Text color={c.estado === 'running' ? 'green' : 'gray'}>{c.estado === 'running' ? '● ' : '○ '}</Text>
              {c.nome}
              <Text dimColor>
                {' '}
                · {c.estado === 'running' ? 'rodando' : 'parado'}
                {c.portas ? ` · porta ${c.portas}` : ''}
              </Text>
            </Text>
          ))}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>
            Servidores MCP
            <Text dimColor>
              {mcps.length > 0 ? ` · ${mcps.length} · ${memoria(mcps.reduce((s, m) => s + m.mb, 0))}` : ''}
            </Text>
          </Text>
          {mcps.length === 0 && <Text dimColor>Nenhum servidor MCP local rodando.</Text>}
          {mcps.map(m => (
            <Box key={`mcp-${m.pid}`} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={DONO_MCP[m.dono].cor}>● </Text>
                <Text bold>{nomeMcp(m.cmd)}</Text>
              </Text>
              <Text dimColor>
                {quemAbriu(m)} · {memoria(m.mb)} · desde {m.inicio} · PID {m.pid}
                {m.processos > 1 ? ` (+${m.processos - 1})` : ''}
                {m.portas.length > 0 ? ` · porta ${m.portas.join(', ')}` : ''}
              </Text>
              <Button
                key={`encerrar-mcp-${m.pid}`}
                dimColor={pedindo !== m.pid}
                onPress={() =>
                  encerrar($, m.pid, m.dono === 'esta' ? 'Use /mcp para reconectar as ferramentas dele.' : undefined)
                }
              >
                {pedindo === m.pid ? DONO_MCP[m.dono].confirmar : 'Encerrar'}
              </Button>
            </Box>
          ))}
        </Box>
      </Box>
    )

    if (ladoALado) {
      return (
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="column" width="50%" flexShrink={1}>
            <Text bold color="cyan">
              Comandos
            </Text>
            <Box marginTop={1}>{corpoComandos}</Box>
          </Box>
          <Box
            flexDirection="column"
            width="50%"
            flexShrink={1}
            paddingLeft={2}
          >
            <Text bold color="cyan">
              Ambiente
            </Text>
            <Box marginTop={1}>{corpoAmbiente}</Box>
          </Box>
        </Box>
      )
    }

    const qtdProcessos = grupos.length
    const guia = (id: Aba, nome: string, contagem: number) => {
      const ativa = abaAtual === id
      return (
        <Button
          key={`aba-${id}`}
          plain
          variant={ativa ? 'primary' : 'secondary'}
          onPress={() => update($, aba, () => id)}
        >
          <Text bold={ativa} underline={ativa} color={ativa ? 'cyan' : undefined} dimColor={!ativa}>
            {nome}
          </Text>
          <Text dimColor>{contagem > 0 ? ` ${contagem}` : ''}</Text>
        </Button>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={3}>
          {guia('comandos', 'Comandos', rodandoCmd)}
          {guia('ambiente', 'Ambiente', qtdProcessos)}
        </Box>
        <Box marginTop={1}>{abaAtual === 'comandos' ? corpoComandos : corpoAmbiente}</Box>
      </Box>
    )
  })
}
