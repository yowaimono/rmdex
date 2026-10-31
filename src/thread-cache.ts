type CacheRecord = {
  key: string
  savedAt: number
  result: unknown
}

const databaseName = 'rmdex-cache'
const storeName = 'threads'
let database: Promise<IDBDatabase | null> | undefined
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function openDatabase() {
  if (database) return database
  database = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      const store = db.createObjectStore(storeName, { keyPath: 'key' })
      store.createIndex('savedAt', 'savedAt')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
  return database
}

export async function loadThreadCache(prefix: string, limit = 20) {
  const db = await openDatabase()
  if (!db) return []
  return new Promise<Array<{ key: string; result: unknown }>>(resolve => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).index('savedAt').openCursor(null, 'prev')
    const records: CacheRecord[] = []
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || records.length >= limit) { resolve(records.filter(record => record.key.startsWith(prefix)).map(({ key, result }) => ({ key, result }))); return }
      const record = cursor.value as CacheRecord
      if (record.key.startsWith(prefix)) records.push(record)
      cursor.continue()
    }
    request.onerror = () => resolve([])
  })
}

export function queueThreadCacheWrite(key: string, result: unknown) {
  const oldTimer = pending.get(key)
  if (oldTimer) clearTimeout(oldTimer)
  const timer = setTimeout(() => {
    pending.delete(key)
    void openDatabase().then(db => {
      if (!db) return
      // IndexedDB uses the structured-clone algorithm. Keep this boundary
      // JSON-only so Vue proxies or other host objects never reach IDB.
      let snapshot: unknown
      try { snapshot = JSON.parse(JSON.stringify(result)) } catch { return }
      try {
        const request = db.transaction(storeName, 'readwrite').objectStore(storeName).put({ key, savedAt: Date.now(), result: snapshot } satisfies CacheRecord)
        request.onerror = () => undefined
      } catch { /* DataCloneError or a closed database must not break the UI. */ }
    })
  }, 750)
  pending.set(key, timer)
}

export async function removeThreadCache(key: string) {
  const timer = pending.get(key)
  if (timer) clearTimeout(timer)
  pending.delete(key)
  const db = await openDatabase()
  if (!db) return
  db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key)
}
