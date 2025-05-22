**Project: Open-Codex GUI with MCP Integration**

Questo progetto estende **open-codex** ([https://github.com/ymichael/open-codex](https://github.com/ymichael/open-codex)) con le modifiche ufficiali del Codex CLI per il supporto MCP (come da PR #824) e aggiunge una GUI desktop leggera e moderna per Windows, macOS e Linux.

---

## 1. Root Directory

```
open-codex-gui/
├── README.md
├── LICENSE
├── package.json
├── .gitignore
├── tsconfig.json           # Config TypeScript
├── electron-builder.json   # Configurazione packaging Electron
├── patch/                  # Patch ufficiale MCP dal repo Codex
│   └── mcp-config.patch    # Diff da PR #824 adattato a open-codex
└── src/                    # Codice sorgente
```

---

## 2. Integrazione MCP in open-codex

1. **Applicazione della patch**

   - Nella cartella `patch/` è presente `mcp-config.patch`, contenente le modifiche della PR #824 di codex ufficiale.
   - Comando per applicarla:

     ```bash
     git clone https://github.com/ymichael/open-codex.git
     cd open-codex
     git apply ../open-codex-gui/patch/mcp-config.patch
     ```

2. **Moduli chiave** (src/mcp/)

   - `config.ts`: estende la lettura di `~/.codex/config.json` per caricare più server MCP.
   - `aggregator.ts`: connette tutti i server, chiama `tools/list` e unifica l'elenco strumenti.
   - `toolRouter.ts`: mantiene mapping tool→server per instradamento chiamate.

3. **Adattamento Prompt LLM**

   - Modifica in `src/llm/promptBuilder.ts`: include descrizioni di tutti gli strumenti aggregati.
   - Parser in `src/llm/responseParser.ts`: rileva selezione tool e parametri.

---

## 3. GUI Desktop (Electron + React + Tailwind)

```
src/
├── main/
│   ├── index.ts          # Entry Electron, avvia finestra principale
│   ├── configManager.ts  # Gestione file config e API Key
│   └── cliBridge.ts      # Wrapper open-codex CLI e moduli MCP
│
├── renderer/
│   ├── index.html
│   ├── App.tsx           # Root React component
│   ├── components/
│   │   ├── Header.tsx    # Selettore modello + API Key
│   │   ├── ServerPanel.tsx # Lista/aggiungi/rimuovi server MCP
│   │   └── WorkspaceSelector.tsx # Selezione directory di lavoro
│   └── pages/
│       ├── Home.tsx      # Form e comandi principali
│       └── Output.tsx    # Visualizzazione risultati e log
│
└── utils/
    ├── types.ts          # Tipi condivisi (ModelConfig, MCPServer)
    └── logger.ts         # Log console & file
```

### Funzionalità principali GUI

- **Modello LLM**: menu a tendina + campo API Key.
- **Server MCP**: aggiungi/modifica/rimuovi con nome, URL, protocollo, token.
- **Cartella di lavoro**: selettore directory locale.
- **Prompt interattivo**: input e pulsanti per comandi `generate`, `explain`, `run`.
- **Modalità Codex**: dropdown per selezionare la modalità di funzionamento di Codex (`auto`, `full-auto`, `suggest`).
- **Istruzioni Custom**: area di editing per il file `instructions.md` per definire il comportamento e il contesto dell'LLM (testo libero con salvataggio automatico).
- **WSL Integration (solo Windows)**:

  - Se l'app rileva Windows, instrada automaticamente i comandi Codex CLI tramite WSL (`bash.exe -c "codex ..."`).
  - Gestione trasparente dei percorsi Windows/WSL: il selettore di directory converte i percorsi in `/mnt/drive/…` per WSL.
  - Opzione per abilitare/disabilitare l'uso di WSL e puntare a un'installazione nativa di Codex CLI se disponibile.

- **Output**: streaming live delle risposte e log dettagliati.

---

## 4. Esempi di Wireframe UI

Di seguito alcune rappresentazioni semplificate dei principali schermi della GUI:

### 4.1 Home / Dashboard

```
┌─────────────────────────────────────────────────┐
│ Open-Codex GUI                                  │
├─────────────────────────────────────────────────┤
│ [API Key: ___________]   [Model: v v] [Mode: v v] │
│                                                 │
│ [ Select Workspace Directory  ]                 │
│                                                 │
│ ┌── Server MCP ───────────────────────────────┐ │
│ │ [x] server1   http://localhost:8000/       │ │
│ │ [ ] server2   https://mcp.example.com/api  │ │
│ │ [+ Add New]  [– Remove Selected]           │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ [ Generate ] [ Explain ] [ Run ]               │
└─────────────────────────────────────────────────┘
```

### 4.2 Finestra di Aggiunta / Modifica Server

```
┌─────────────────────────────────────────────────┐
│ Aggiungi / Modifica Server MCP                  │
├─────────────────────────────────────────────────┤
│ Nome:     [_____________________]               │
│ URL:      [_____________________]               │
│ Protocol: [ jsonrpc v]                          │
│ Token:    [_____________________]               │
│                                                 │
│           [Salva]    [Annulla]                  │
└─────────────────────────────────────────────────┘
```

### 4.3 Output / Log

```
┌─────────────────────────────────────────────────┐
│ Output:                                         │
├─────────────────────────────────────────────────┤
│ > Generazione in corso...                       │
│ def hello():
│     print("Hello, World!")                    │
│                                                 │
│ [ Copia ] [ Salva su file ]                     │
└─────────────────────────────────────────────────┘
```

---

## 5. Build, Dev e Packaging

- **Dev**: `npm install && npm run dev`

- **Build**: `npm run build && electron-builder`

- **Output**: installer e app portable in `dist/`

- **Dev**: `npm install && npm run dev`

- **Build**: `npm run build && electron-builder`

- **Output**: installer e app portable in `dist/`

---

## 5. Estensioni Future

Per rendere l'app sempre reattiva, sicura e personalizzabile, ecco le funzionalità da implementare:

- **Hot-reload per plugin MCP**

  - Caricamento dinamico dei nuovi moduli MCP senza riavviare l'applicazione.
  - Monitor file system: rileva modifiche nella cartella `plugins/` e aggiorna la lista strumenti a runtime.
  - Notifiche in-app per l'installazione o l'aggiornamento dei plugin.

- **Aggiornamenti automatici**

  - Integrazione con `electron-updater` per scaricare e installare nuove release in background.
  - Controllo versione all'avvio e notifica user-friendly quando è disponibile un aggiornamento.

- **Temi chiaro / scuro**

  - Implementazione di switch per passare tra light e dark mode.
  - Salvataggio preferenza utente in `config.json` e applicazione CSS dinamica con Tailwind.

- **Localizzazione (i18n)**

  - Supporto multi-lingua tramite pacchetto `react-i18next`.
  - File di traduzione in `public/locales/{en, it, ...}/translation.json`.
  - Rilevamento automatico della lingua di sistema con fallback a inglese.

- **Plugin marketplace (future)**

  - Interfaccia per sfogliare e installare plugin MCP ufficiali e di terze parti.
  - Gestione dipendenze e verifica integrità via checksum.

---

_Con queste estensioni, l'app diventa modulare, sempre aggiornata e facilmente personalizzabile dagli utenti._
