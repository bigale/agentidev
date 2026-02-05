# Debugging Worker "Failed to fetch" Error

## What's Happening

The embeddings worker is trying to download the `all-MiniLM-L6-v2` model from Hugging Face CDN and failing.

## Common Causes

1. **Service Worker Lifecycle Issue** - Chrome extension reload interrupted model download
2. **Network/CORS Issue** - Blocked access to Hugging Face CDN
3. **Cache Corruption** - Model cache got corrupted during reload
4. **CSP Restriction** - Content Security Policy blocking the fetch

## Debugging Steps

### 1. Check Service Worker Console

Open Chrome DevTools → Service Workers → Inspect the offscreen document worker:

```
chrome://extensions/ → Click "Inspect views: offscreen-embeddings.html"
```

Look for the full error with stack trace.

### 2. Check Network Tab

In the worker console, go to Network tab and reload. Look for:
- Failed requests to `huggingface.co` or `cdn.huggingface.co`
- What status code? (CORS error, 404, timeout?)

### 3. Try Manual Reload

Close all extension pages, then:

```javascript
// In extension console
chrome.runtime.reload();
```

### 4. Check Browser Cache

The model should be cached after first download. Check if it's there:

```javascript
// In extension console
caches.keys().then(keys => {
  console.log('Cache keys:', keys);
  keys.forEach(async key => {
    const cache = await caches.open(key);
    const requests = await cache.keys();
    console.log(key, '→', requests.length, 'cached items');
  });
});
```

## Quick Fixes to Try

### Fix 1: Clear Extension Cache

```javascript
// Clear all caches
caches.keys().then(keys => {
  keys.forEach(key => caches.delete(key));
  console.log('✓ Cleared', keys.length, 'caches');
});

// Then reload extension
chrome.runtime.reload();
```

### Fix 2: Check manifest.json Permissions

Make sure `manifest.json` has:

```json
{
  "permissions": [
    "storage",
    "unlimitedStorage"
  ],
  "host_permissions": [
    "https://*.huggingface.co/*"
  ]
}
```

### Fix 3: Disable/Re-enable Extension

Sometimes Chrome needs a full cycle:
1. Go to `chrome://extensions/`
2. Toggle extension OFF
3. Wait 2 seconds
4. Toggle extension ON

### Fix 4: Check if It's a Temporary Network Issue

Try accessing the model URL directly in browser:
```
https://huggingface.co/Xenova/all-MiniLM-L6-v2
```

If that fails, it's a network/DNS issue.

## Workaround: Use Without Embeddings

If the worker won't initialize, the extension can still work with embeddings disabled. The IXML spec RAG feature will be disabled, but grammar generation will still work using the improved prompt.

## Is This Related to My Change?

**No** - The vectordb.js change only modified the search result mapping (line 115). It doesn't affect:
- Worker initialization
- Model downloading
- Fetch operations

This is likely a Chrome extension service worker lifecycle issue that happened to occur after reload.

## Expected Behavior After Fix

You should see:
```
[Worker] Initializing transformers.js...
[Worker] Loading from: chrome-extension://[id]/lib/transformers/transformers.js
[Worker] Loading all-MiniLM-L6-v2 model (384-dim)...
[Worker] Model loaded successfully
```

## Need More Info?

Please share:
1. Full error from Service Worker console (with stack trace)
2. Any failed network requests
3. Chrome version
4. Whether this is the first time loading the extension or a reload
