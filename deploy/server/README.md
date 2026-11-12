# deploy/server : VM-side proxies (TTS + OCR)

- `tts/`  : existing TTS proxy (`pyreader-tts`, 127.0.0.1:8090), copied verbatim from the VM source
            (`server.py` and the unit are byte-identical to the previously un-versioned copy). Wheels are not stored here.
- `ocr/`  : new OCR proxy (`pyreader-ocr`, 127.0.0.1:8091), `POST /ocr/v1/page`, `GET /ocr/v1/usage`.
- `Caddyfile.ocr.snippet` : the `handle_path /ocr/*` block.
- `tests/` : `python -m unittest discover -s deploy/server/tests -v` (fake DashScope on localhost, no network, no key).

The two services deliberately share no code: auth/quota/limiter are small and the OCR copies are adapted
(pages instead of billable chars, allow-list, per-user monthly cap), so the live TTS behaviour is untouched.

Secrets: only `env.example` / `tokens.example.json` are committed. Real `/etc/pyreader-*/env` and `tokens.json` stay on the VM.

## Annotation (双行小注) handling
Prompt asks the model to keep small annotations inline at their natural reading position wrapped as `【注：……】`
so they are read aloud. Client may later strip them with `/【注：[^】]*】/g`.

## Deploy checklist (not automated)
1. Create user `pyreader-ocr`; `mkdir /opt/pyreader-ocr /etc/pyreader-ocr`; copy `ocr/server.py` to `/opt/pyreader-ocr/`.
2. `/etc/pyreader-ocr/env` (0600) with `DASHSCOPE_API_KEY` (owner writes it); `/etc/pyreader-ocr/tokens.json` = hash table
   (copy hashes from the TTS tokens.json; OCR allow-list is `gary,qian` by `OCR_ALLOWED_USERS`).
3. Install `ocr/pyreader-ocr.service` to `/etc/systemd/system/`, `daemon-reload`, `enable --now`; curl 127.0.0.1:8091 directly first.
4. Back up Caddyfile, add `Caddyfile.ocr.snippet`, `caddy validate`, reload.
5. Real 3-page smoke by the owner; set a DashScope budget alert.
Rollback: `systemctl disable --now pyreader-ocr`, restore Caddyfile.
