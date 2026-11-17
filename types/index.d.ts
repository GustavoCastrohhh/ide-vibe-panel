export type Situacao = 'rodando' | 'segundo-plano' | 'ok' | 'falhou' | 'interrompido' | 'negado'

/** Um comando de terminal que o Claude rodou (Bash ou PowerShell). */
export type Comando = {
  id: string
  ferramenta: 'Bash' | 'PowerShell'
  comando: string
  descricao: string
  situacao: Situacao
  inicio: number
  duracaoMs: number | null
  tarefaId: string | null
}

/** Uma árvore de processos do projeto (o processo de cima e todos os filhos). */
export type Grupo = {
  pid: number
  processos: number
  mb: number
  inicio: string
  idadeS: number
  portas: number[]
  cmd: string
}

export type Container = {
  nome: string
  estado: string
  status: string
  portas: string
}

/**
 * Um servidor MCP local (o processo de cima e todos os filhos), de qualquer projeto.
 * `dono`: aberto por esta sessão, por outra sessão aberta, por uma sessão que já
 * fechou (esquecido) ou por outro programa (`app`).
 */
export type Mcp = {
  pid: number
  processos: number
  mb: number
  inicio: string
  portas: number[]
  cmd: string
  dono: 'esta' | 'outra' | 'fechada' | 'app'
  sessao: number
  sessaoInicio: string
  app: string
}

export type Leitura = {
  raiz: string
  agora: string
  grupos: Grupo[]
  docker: Container[]
  dockerDisponivel: boolean
  mcp: Mcp[]
  erro: string | null
}

export type Aba = 'comandos' | 'ambiente'

declare module 'claude-code' {
  interface PluginState {
    'ide-vibe-panel': {
      aba: Aba
      comandos: Shaped<Comando[]>
      leitura: Shaped<Leitura | null>
      confirmando: number | null
    }
  }
}
