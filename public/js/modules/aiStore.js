const DB_NAME = "mori_ai_v1";
const DB_VERSION = 2;
const ANALYSIS_STORE = "analyses";
const FILE_STORE = "fileAnalyses";
let databasePromise = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ANALYSIS_STORE)) {
        const store = db.createObjectStore(ANALYSIS_STORE, { keyPath: "key" });
        store.createIndex("imageHash", "imageHash", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        const files = db.createObjectStore(FILE_STORE, { keyPath: "fileKey" });
        files.createIndex("imageHash", "imageHash", { unique: false });
        files.createIndex("pose", "analysis.pose", { unique: false });
        files.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("AI analysis database unavailable"));
  });
  return databasePromise;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("AI analysis database request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("AI analysis transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("AI analysis transaction aborted"));
  });
}

export function analysisKey({ imageHash, model, language, promptVersion = "v1" }) {
  return `${imageHash}|${model}|${language}|${promptVersion}`;
}

export async function getAiAnalysis(key) {
  const db = await openDatabase();
  const transaction = db.transaction(ANALYSIS_STORE, "readonly");
  return (await requestValue(transaction.objectStore(ANALYSIS_STORE).get(key))) || null;
}

export async function putAiAnalysis(value) {
  if (!value?.key || !value?.imageHash || !value?.analysis) throw new Error("Invalid AI analysis record");
  const db = await openDatabase();
  const transaction = db.transaction(ANALYSIS_STORE, "readwrite");
  transaction.objectStore(ANALYSIS_STORE).put({
    ...value,
    updatedAt: Number(value.updatedAt) || Date.now(),
  });
  await transactionDone(transaction);
}

export async function putAiFileAnalysis(value) {
  if (!value?.fileKey || !value?.imageHash || !value?.analysis) {
    throw new Error("Invalid AI file analysis record");
  }
  const db = await openDatabase();
  const transaction = db.transaction(FILE_STORE, "readwrite");
  transaction.objectStore(FILE_STORE).put({
    ...value,
    updatedAt: Number(value.updatedAt) || Date.now(),
  });
  await transactionDone(transaction);
}

export async function getAiFileAnalysis(fileKey) {
  if (!fileKey) return null;
  const db = await openDatabase();
  const transaction = db.transaction(FILE_STORE, "readonly");
  return (await requestValue(transaction.objectStore(FILE_STORE).get(String(fileKey)))) || null;
}

export async function listAiFileAnalyses({ limit = 10000 } = {}) {
  const db = await openDatabase();
  const transaction = db.transaction(FILE_STORE, "readonly");
  const request = transaction.objectStore(FILE_STORE).getAll();
  const values = await requestValue(request);
  return values.slice(0, Math.max(1, Math.min(10000, Number(limit) || 10000)));
}

export async function clearAiAnalyses() {
  const db = await openDatabase();
  const transaction = db.transaction([ANALYSIS_STORE, FILE_STORE], "readwrite");
  transaction.objectStore(ANALYSIS_STORE).clear();
  transaction.objectStore(FILE_STORE).clear();
  await transactionDone(transaction);
}
