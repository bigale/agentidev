# Ollama CORS Fix

Ollama blocks requests from `chrome-extension://` origins (returns 403).
The extension needs to reach Ollama at `localhost:11434`.

## Fix: Allow all origins

```bash
sudo systemctl edit ollama
```

Add:
```ini
[Service]
Environment="OLLAMA_ORIGINS=*"
```

Then restart:
```bash
sudo systemctl restart ollama
```

## Verify
```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Origin: chrome-extension://test" \
  http://localhost:11434/v1/chat/completions \
  -d '{"model":"llama3.2:3b","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  -H "Content-Type: application/json"
```
Should return `200` (not `403`).
