import { initDB, exportAll, DB_PATH } from '../db.mjs';

initDB();
console.log('DB path:', DB_PATH);

const all = exportAll();
console.log('\n--- Tables ---');
console.log('script_runs:     ', all.script_runs.length, 'rows');
console.log('script_artifacts:', all.script_artifacts.length, 'rows');
console.log('idb_stores:      ', all.idb_stores.length, 'rows');

if (all.idb_stores.length) {
  const stores = [...new Set(all.idb_stores.map(r => r.store))];
  console.log('\nIDB store names:', stores);
  stores.forEach(name => {
    const rows = all.idb_stores.filter(r => r.store === name);
    console.log(' ', name + ':', rows.length, 'records');
    if (rows.length) console.log('   sample:', rows[0].data.slice(0, 120));
  });
}

if (all.script_runs.length) {
  console.log('\nLatest script runs:');
  all.script_runs.slice(0, 5).forEach(r =>
    console.log(' ', r.name, '|', r.state, '|', new Date(r.started_at).toLocaleString())
  );
}
