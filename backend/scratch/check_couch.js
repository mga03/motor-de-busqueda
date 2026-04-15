async function check() {
  const auth = 'Basic ' + Buffer.from('admin:password').toString('base64');
  const baseUrl = 'http://localhost:5984';
  try {
    const db = 'service_type';
    const docsRes = await fetch(`${baseUrl}/${db}/_all_docs`, { headers: { 'Authorization': auth } });
    const docs = await docsRes.json();
    for (const docId of docs.rows.map(r => r.id)) {
        const docRes = await fetch(`${baseUrl}/${db}/${docId}`, { headers: { 'Authorization': auth } });
        const doc = await docRes.json();
        console.log(`Doc ID: ${docId}`);
        console.log(JSON.stringify(doc, null, 2));
    }
  } catch (e) {
    console.error(e);
  }
}

check();
