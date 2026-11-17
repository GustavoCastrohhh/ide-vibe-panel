# ide-vibe-panel

Mod do Claude Code que abre um painel ao lado do chat, com duas abas:

- **Comandos**: os comandos de terminal (Bash e PowerShell) que o Claude roda, com o que está rodando agora e a situação de cada um.
- **Ambiente**: o que está rodando do projeto na máquina (backend, frontend, testes, containers do Docker) e os servidores MCP locais.

Para abrir o painel, digite `/painel` no Claude Code.

## Onde funciona

O mod funciona em qualquer IDE baseada no VS Code.
Quem roda o mod é o Claude Code.
A IDE precisa ter a extensão do Claude Code instalada: VS Code, Cursor, Windsurf, VSCodium, Antigravity.

O mod também funciona fora de IDE: no Claude Code pelo terminal (inclusive no terminal do JetBrains) e no app desktop.

A aba **Ambiente** só funciona no Windows: ela lê os processos pelo PowerShell. A aba **Comandos** funciona em Windows, Mac e Linux.

## Como instalar

No prompt do Claude Code, no terminal:

```
/plugin install ide-vibe-panel --marketplace GustavoCastrohhh/ide-vibe-panel
```

Responda `y` para adicionar o marketplace e escolha o escopo de usuário (Enter).

Por um shell:

```
claude plugin install ide-vibe-panel --marketplace GustavoCastrohhh/ide-vibe-panel
```

No app desktop, onde o `/plugin` não roda: clique no **+** ao lado da caixa do prompt, depois **Plugins**, **Add marketplace** com `GustavoCastrohhh/ide-vibe-panel` e **Add plugin**.

Depois de instalar, abra uma conversa nova do Claude Code e digite `/painel`.
