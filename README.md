# HelpAI

Strumento locale che governa la coerenza tra le specifiche `*.helpai.md` di un repository e il codice delle sue cartelle. Analizza il progetto, valida le spec, costruisce il grafo delle dipendenze e avvia l'allineamento Spec → Code tramite un harness AI.

## Avvio

```bash
npm install
npm run build
npm start            # oppure: node dist/server/main.js
```

Apri `http://127.0.0.1:4321`.

## Configurazione del progetto target

Il progetto da analizzare **non** si passa all'avvio. Al primo avvio la Web UI chiede il percorso assoluto della cartella del progetto (`rootPath`); il valore viene salvato in `data/config.json` e può essere cambiato in qualsiasi momento dalla UI (il cambio è rifiutato mentre un run è attivo).

API equivalenti:

```bash
curl -s http://127.0.0.1:4321/api/config
curl -s -X PUT http://127.0.0.1:4321/api/config -H 'content-type: application/json' -d '{"rootPath":"/abs/path/al/progetto"}'
```

Finché `rootPath` non è configurato, gli endpoint di progetto rispondono `409`.

## Harness Hermes

Configurazione dalla Web UI (pannello "Harness Hermes"):

- **docker-compose.yml**: percorso assoluto al file di Hermes (es. `/home/lucart/hermes/docker-compose.yml`).
- **Modello**: stringa libera. Vuoto = `default` (nessun flag `-m`, si usa il default di Hermes).
- **Testa harness**: esegue `hermes chat -Q -q "Rispondi solo con la parola OK"` nel container `hermes-agent`. Se la risposta contiene `OK`, l'harness è verificato.

Lo Spec→Code è bloccato finché l'harness non è verificato. Ogni modifica di modello o compose richiede un nuovo test.

Comando eseguito da HelpAI: `docker compose -f <compose> exec -T hermes-agent hermes chat -Q [-m <modello>] -q <prompt>`.

## Variabili d'ambiente

| Variabile | Default | Significato |
|---|---|---|
| `HELPAI_PORT` | `4321` | Porta HTTP (bind su 127.0.0.1) |
| `HELPAI_DATA_DIR` | `./data` | Dove vive `config.json` (rootPath) |
| `HELPAI_HARNESS` | `mock` | `mock` oppure `cli` |
| `HELPAI_HARNESS_CMD` | — | Comando dell'harness CLI (solo con `cli`) |
| `HELPAI_HARNESS_ARGS` | — | Argomenti, separati da spazio |

## Regole principali

- Massimo un `.helpai.md` per cartella (`MULTIPLE_SPEC_FILES_IN_FOLDER`).
- Link tra spec: risolti anche fuori dal progetto se raggiungibili; se non risolvibili → `BROKEN_SPEC_LINK`. Cicli → `CIRCULAR_SPEC_DEPENDENCY`.
- L'allineamento è bloccato se la spec o le sue basi hanno errori.
- Modifiche solo nella cartella della spec; il resto viene annullato dopo il run.
- **YOLO**: applica senza conferme, annulla ciò che è fuori perimetro.
- **CTRL**: chiede approvazione per ogni file; i rifiutati vengono ripristinati.
- Stato in `<progetto>/.helpai/state.json`; storico degli ultimi 3 run in `<progetto>/.helpai/history/`.

## API

| Metodo | Percorso | Descrizione |
|---|---|---|
| GET | `/api/config` | rootPath corrente |
| PUT | `/api/config` | imposta/cambia rootPath |
| GET | `/api/project` | contatori, nodi, archi, errori |
| POST | `/api/project/rescan` | nuova scansione |
| GET | `/api/specs/:id` | dettaglio nodo + contenuto (id URL-encoded) |
| PUT | `/api/specs/:id` | salva la spec |
| GET | `/api/specs/:id/history?a=&b=` | storico e confronto |
| POST | `/api/specs/:id/align` | avvia Spec → Code (`{"mode":"yolo"\|"ctrl"}`), risponde 202 con `runId` |
| POST | `/api/runs/:runId/decision` | approvazione CTRL (`{"keep":true\|false}`) |
| GET | `/api/runs/:runId/stream` | SSE con log e stato del run |
| POST | `/api/specs/:id/reverse-align` | Code → Spec: non ancora implementato (501) |

## Stato del progetto

- [x] M1 — Core Engine (scanner, parser, validatore, grafo)
- [x] M2 — Context builder, harness, YOLO/CTRL, stato, storico
- [x] M3 — Backend API, configurazione rootPath dalla Web UI
- [ ] M4 — Web UI (vedi `docs/ROADMAP.md`)
- [ ] M5 — Packaging Docker (vedi `docs/ROADMAP.md`)

## Test

```bash
npm test          # Vitest
npm run typecheck
```
