import { readFileSync } from 'fs';

const treePath = 'C:/Users/everiale/source/repos/smartclient/smartclientSDK/isomorphic/system/reference/exampleTree.js';
const src = readFileSync(treePath, 'utf8');

// Find all id/jsURL pairs near "savedSearch" or "SavedSearch"
const chunks = src.split(/(?=\{id:)/);
const saved = chunks.filter(c => /[Ss]aved[Ss]earch/.test(c)).slice(0, 10);

saved.forEach(chunk => {
  const id    = (chunk.match(/id:"([^"]+)"/)     || [])[1];
  const jsURL = (chunk.match(/jsURL:"([^"]+)"/)  || [])[1];
  const title = (chunk.match(/title:"([^"]+)"/)  || [])[1];
  console.log({ id, jsURL, title });
});
