const DATABASE = 'tab-recorder-zh-v1';
const VERSION = 2;
function openDatabase() {
  return new Promise((resolve,reject)=>{
    const request = indexedDB.open(DATABASE,VERSION);
    request.onupgradeneeded = () => {
      const db=request.result;
      if(!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions',{keyPath:'id'});
      if(!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks',{keyPath:['id','index']});
      if(!db.objectStoreNames.contains('previews')) db.createObjectStore('previews',{keyPath:'id'});
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function dbWrite(storeName, data) {
  const db=await openDatabase();
  try {
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(storeName,'readwrite');
      tx.objectStore(storeName).put(data);
      tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error || new Error('数据库事务中断'));
    });
  } finally {db.close();}
}
// Commit each chunk and its recovery checkpoint in the same transaction.
async function dbAppendChunk(session, record) {
  const db=await openDatabase();
  try {await new Promise((resolve,reject)=>{
    const tx=db.transaction(['sessions','chunks'],'readwrite');
    tx.objectStore('chunks').put(record);tx.objectStore('sessions').put(session);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('录制分片保存中断'));
  });}finally{db.close();}
}
async function dbRecoverRecordings() {
  const sessions=await dbAllSessions();
  for(const session of sessions.filter(item=>item.status==='recording'&&item.chunkCount>0)) {
    await dbWrite('sessions',{...session,status:'ready',durationMs:session.savedDurationMs||session.durationMs||session.chunkCount*1000,completedAt:session.lastSavedAt||Date.now(),recovered:true});
  }
}
async function dbRead(storeName,key) {
  const db=await openDatabase();
  try {return await new Promise((resolve,reject)=>{
    const req=db.transaction(storeName).objectStore(storeName).get(key);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });} finally {db.close();}
}
async function dbAllSessions() {
  const db=await openDatabase();
  try {return await new Promise((resolve,reject)=>{
    const req=db.transaction('sessions').objectStore('sessions').getAll();
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });} finally {db.close();}
}
async function dbChunks(id) {
  const db=await openDatabase();
  try {return await new Promise((resolve,reject)=>{
    const tx=db.transaction('chunks');
    const range=IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
    const req=tx.objectStore('chunks').getAll(range);
    req.onsuccess=()=>resolve(req.result.sort((a,b)=>a.index-b.index));
    req.onerror=()=>reject(req.error);
  });} finally {db.close();}
}
async function dbDelete(id) {
  const db=await openDatabase();
  try {await new Promise((resolve,reject)=>{
    const tx=db.transaction(['sessions','chunks','previews'],'readwrite');
    tx.objectStore('sessions').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));
    tx.objectStore('previews').delete(id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error);
  });} finally {db.close();}
}
