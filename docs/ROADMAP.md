# Roadmap: milestone rimanenti

Riferimento: `piano_di_sviluppo_helpai.md`, sezioni 6, 7 e 8.

## Vincolo trasversale: rootPath dalla Web UI

Il progetto target non è un parametro di avvio. Vale per M4 e M5:

- Al primo avvio, se `GET /api/config` restituisce `configured: false`, la UI mostra una schermata di configurazione con un campo per il percorso assoluto. Il bottone invoca `PUT /api/config`.
- Dal header è sempre possibile cambiare il rootPath. Il backend rifiuta il cambio con `409` mentre ci sono run attivi; la UI deve disabilitare il bottone in quel caso.
- Il rootPath deve essere un percorso visibile al processo che esegue HelpAI. In Docker questo significa che il percorso scelto dall'utente è un percorso **interno al container** (vedi M5).

## M4 — Web UI essenziale — COMPLETATA (verifica browser ancora da fare)

Stato: backend, asset statici e 33/33 test verificati. La verifica nel browser non è stata eseguita perché Chromium non è disponibile nell'ambiente di sviluppo; va fatta dall'utente.

Obiettivo: l'utente configura il progetto, vede lo stato e avvia gli allineamenti senza usare curl.

Da fare:
1. **Servire la UI dal backend**: build statica (Vite + Preact o HTML/TS) servita da Fastify su `/`. Nessun framework pesante.
2. **Onboarding rootPath**: schermata di primo avvio e cambio successivo (vedi vincolo trasversale). Validazione lato server con messaggio d'errore leggibile.
3. **Header / barra di stato**: rootPath corrente, pulsante Rescan, contatori `total / synced / stale / error / never`.
4. **Pannello errori**: sempre visibile se presenti; mostra codice, cartelle e file coinvolti per `MULTIPLE_SPEC_FILES_IN_FOLDER`, `BROKEN_SPEC_LINK`, `CIRCULAR_SPEC_DEPENDENCY`.
5. **Grafo interattivo**: Cytoscape.js. Nodi = spec, archi = dipendenze upstream → downstream. Colore per stato: `synced`, `stale`, `error`, `never`, `running`. Click apre il dettaglio.
6. **Vista lista/albero**: alternativa filtrabile per cartella.
7. **Pannello dettaglio**: percorso cartella e spec, upstream, downstream, file diretti (con sottocartelle ignorate), editor del `.helpai.md` con salvataggio via `PUT`, pulsanti "Allinea Codice (Spec → Code)" e "Allinea Spec dal Codice (Code → Spec)" (quest'ultimo disabilitato finché non implementato).
8. **Selettore modalità**: YOLO / CTRL prima dell'avvio di un allineamento.
9. **Console live**: SSE da `/api/runs/:runId/stream`. In CTRL mostra un prompt per ogni file con Approva / Rifiuta che chiama `POST /api/runs/:runId/decision`. Al termine mostra file applicati e annullati.
10. **Confronto storico**: lista degli ultimi 3 run della spec e confronto file per file tramite `/history?a=&b=`.

Criteri di verifica (dati misurati, non dichiarati):
- Avvio pulito senza `rootPath` → schermata di configurazione.
- Impostazione di un percorso valido → grafo visibile con il numero di nodi atteso.
- Percorso non valido → messaggio di errore, nessun cambio.
- CTRL: approvare un file e rifiutarne un altro → verificato sul filesystem.
- Verifica nel browser prima di dichiarare risolto un bug UI.

## M4b — Harness Hermes e allineamento (in corso)

- [x] Adapter `HermesHarness` (docker compose exec, modello opzionale)
- [x] Config modello (stringa, default se vuoto) e percorso compose
- [x] Test harness via API e UI; Spec→Code bloccato se non verificato
- [ ] Verifica browser del pannello Harness
- [ ] Run reale di allineamento su project-test

## M5 — Packaging Docker e documentazione d'uso

Obiettivo: un solo comando avvia tutto in locale.

Da fare:
1. **`docker/Dockerfile` multi-stage**: stage build (TypeScript + build UI) → stage runtime Node 20 slim con solo `dist/` e dipendenze di produzione.
2. **`docker/docker-compose.yml`**:
   - Repo target montato in un percorso fisso, es. `- /percorso/host/progetto:/workspace`. L'utente inserisce `/workspace` come rootPath nella UI.
   - `HELPAI_DATA_DIR=/data` con volume dedicato, così `config.json` sopravvive ai riavvii.
   - Porta `${HELPAI_PORT:-4321}:4321`.
   - Il server deve ascoltare su `0.0.0.0` **solo** nel container (variabile `HELPAI_HOST`, default `127.0.0.1`). Da aggiungere in M5.
   - Variabili dell'harness CLI da `.env`.
3. **UID / GID**: build arg e `user:` in compose, così i file modificati nel volume mantengono la proprietà dell'utente host.
4. **README**: avvio rapido con compose, configurazione del rootPath dalla UI, esempio pratico (`component-base.helpai.md` + componenti figli), guida all'harness, tabella variabili (già presente in `README.md`).
5. **Cartella di esempio**: fixture del progetto di test versionata, per il primo avvio dimostrativo.

Criteri di verifica:
- `docker compose up --build` → UI raggiungibile su `http://localhost:4321`.
- Impostazione di `/workspace` dalla UI → grafo della fixture visibile.
- File creati dall'harness appartengono all'UID dell'host.
- Riavvio del container → rootPath ancora impostato (volume `/data`).

Nota: Docker non è installato nell'ambiente di sviluppo attuale. La verifica di M5 va eseguita su una macchina con Docker.

## Decisioni già prese

- Stack: TypeScript strict, Node ≥ 20, Fastify, Vitest, Cytoscape.js, Vite + Preact.
- Harness: `MockHarness` ora; adapter GitHub Copilot in seguito.
- Git: da collegare dopo, nessun commit automatico.
- Nessuna autenticazione: uso locale.
- Reverse-align (Code → Spec): fuori dallo scope attuale, endpoint 501.
