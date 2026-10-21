const DB_NAME = 'sc-hauling-ocr'
const STORE = 'sample'
const KEY = 'calibration'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

/** Persist the OCR region calibration screenshot across reloads. */
export async function saveOcrSampleFile(file: Blob): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(file, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save sample image'))
  })
  db.close()
}

export async function loadOcrSampleFile(): Promise<Blob | null> {
  try {
    const db = await openDb()
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => {
        const v = req.result
        resolve(v instanceof Blob ? v : null)
      }
      req.onerror = () => reject(req.error ?? new Error('Failed to load sample image'))
    })
    db.close()
    return blob
  } catch {
    return null
  }
}

export async function clearOcrSampleFile(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear sample image'))
    })
    db.close()
  } catch {
    /* ignore */
  }
}
