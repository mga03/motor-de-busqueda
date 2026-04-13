const { Client } = require('@elastic/elasticsearch');
require('dotenv').config();

const nodes = (process.env.ELASTIC_NODES || '').split(',');
const user = process.env.ELASTIC_USER;
const password = process.env.ELASTIC_PASSWORD;

console.log('Testing connectivity to:', nodes);

const client = new Client({
  nodes: nodes,
  auth: {
    username: user,
    password: password
  },
  tls: {
    rejectUnauthorized: false
  }
});

async function run() {
  try {
    const info = await client.info();
    console.log('SUCCESS: All nodes are visible and authentication accepted.');
    console.log('Cluster Info:', info);
  } catch (error) {
    console.error('FAILURE: Could not connect to the cluster.');
    console.error('Error Details:', error.message);
    if (error.message.includes('living connections') || error.message.includes('Timeout')) {
       console.log('\n💡 TIP: Verifica que tienes la VPN corporativa encendida.');
    }
  }
}

run();
