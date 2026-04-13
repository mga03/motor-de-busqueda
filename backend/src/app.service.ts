import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly couchUrl = process.env.COUCHDB_URL ?? 'http://localhost:5984';
  private readonly couchDb = process.env.COUCHDB_DB ?? 'service_type';

  private readonly nodes = (process.env.ELASTIC_NODES || 'http://localhost:9200').split(',');
  private readonly auth = Buffer.from(`${process.env.ELASTIC_USER || 'elastic'}:${process.env.ELASTIC_PASSWORD || 'Ax10nAx10n'}`).toString('base64');
  private readonly httpsAgent = new https.Agent({ rejectUnauthorized: false });

  private currentNodeIndex = 0;

  private async esRequest(path: string, method: string = 'GET', body: any = null) {
    let lastError: any;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[this.currentNodeIndex].replace(/\/+$/, '');
      const url = `${node}/${path.replace(/^\/+/, '')}`;

      try {
        const options: any = {
          method,
          headers: {
            'Authorization': `Basic ${this.auth}`,
            'Content-Type': 'application/json',
          },
          // Node.js native fetch uses 'dispatcher' instead of 'agent' but for global fetch 
          // in Node 18+ we often need to use undici if we want to bypass SSL.
          // However, for simplicity and compatibility, we use the global fetch.
          // IF Node version is 18+, we can use the following trick for rejectUnauthorized:
        };

        // Native fetch SSL bypass trick for Node 18+
        if (url.startsWith('https')) {
          (options as any).dispatcher = new (require('undici').Agent)({
            connect: { rejectUnauthorized: false }
          });
        }

        if (body) options.body = JSON.stringify(body);

        const resp = await fetch(url, options);
        if (!resp.ok && resp.status >= 500) {
          throw new Error(`Node error: ${resp.status}`);
        }

        return resp;
      } catch (err) {
        this.logger.warn(`Node ${node} unreachable or error. Trying next node...`);
        lastError = err;
        this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodes.length;
      }
    }

    throw lastError;
  }

  async getFilters(templateId: string = 'icons_hpov') {
    const url = `${this.couchUrl}/${this.couchDb}/${templateId}`;
    try {
      const auth = Buffer.from('admin:password').toString('base64');
      const resp = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });
      if (!resp.ok) throw new Error('CouchDB fail');
      const doc = await resp.json() as any;
      return { history: { filters: doc?.history?.filters || [] } };
    } catch (e) {
      return { history: { filters: [{ label: 'Nombre', attrib: 'ID' }, { label: 'Equipamiento', attrib: 'meta.equipment' }] } };
    }
  }

  buildSearchQuery(filters: Record<string, any>, size = 100, searchAfter?: string[]) {
    const must: any[] = [];
    if (filters.ID) {
      const queryValue = filters.ID.includes('*') ? filters.ID : `*${filters.ID}*`;
      must.push({ wildcard: { "ID": queryValue } });
      delete filters.ID;
    }
    if (filters.State) {
      must.push({ term: { "State": filters.State } });
      delete filters.State;
    }
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value == null || value === '') continue;
      const fieldPath = key.startsWith('meta.') ? key : `meta.${key}`;
      must.push({ term: { [fieldPath]: value } });
    }

    const body: any = {
      size,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort: [{ ID: 'asc' }],
    };
    if (searchAfter) body.search_after = searchAfter;
    return body;
  }

  async search(templateId: string, projectName: string, filters: Record<string, any>, size = 100, searchAfter?: string[]) {
    const esIndex = `${templateId}.${projectName}`;
    const body = this.buildSearchQuery(filters, size, searchAfter);

    try {
      const resp = await this.esRequest(`${esIndex}/_search`, 'POST', body);
      const result = await resp.json() as any;

      const hits = result.hits?.hits?.map((h: any) => ({
        id: h._id,
        score: h._score,
        source: h._source,
        sort: h.sort
      })) ?? [];

      return {
        took: result.took,
        total: typeof result.hits?.total === 'object' ? result.hits.total.value : result.hits?.total,
        hits,
        search_after: hits.length > 0 ? hits[hits.length - 1].sort : undefined,
      };
    } catch (error) {
      if (error.message.includes('Timeout') || error.message.includes('fetch') || error.code === 'ECONNREFUSED') {
        throw new Error('Esperando conexión con red corporativa/VPN');
      }
      throw error;
    }
  }

  async setupIndexAndSample(templateId: string, projectName: string) {
    const esIndex = `${templateId}.${projectName}`;
    try {
      const checkRes = await this.esRequest(esIndex, 'HEAD');
      if (checkRes.status === 200) {
        await this.esRequest(esIndex, 'DELETE');
      }

      await this.esRequest(esIndex, 'PUT', {
        mappings: {
          properties: {
            ID: { type: 'keyword' },
            State: { type: 'keyword' },
            meta: { properties: { province: { type: 'keyword' }, center: { type: 'keyword' }, equipment: { type: 'keyword' }, severity: { type: 'keyword' } } },
          },
        },
        settings: { number_of_shards: 3, number_of_replicas: 1 },
      });

      const doc = { ID: 'BAZA.TX_PPAL_01', State: '1', meta: { province: 'GRANADA', center: 'GRA194001', equipment: 'EGATEL_MUX', severity: '1' } };
      await this.esRequest(`${esIndex}/_doc/${encodeURIComponent(doc.ID)}`, 'PUT', doc);

      return { message: `Index ${esIndex} and sample document ready`, doc };
    } catch (error) {
      if (error.message.includes('Timeout') || error.message.includes('fetch')) throw new Error('Esperando conexión con red corporativa/VPN');
      throw error;
    }
  }

  async seedData(templateId: string, projectName: string, count: number = 50) {
    const esIndex = `${templateId}.${projectName}`;
    const BATCH_SIZE = 1000;
    let seeded = 0;

    const provinces = ['SEVILLA', 'MADRID', 'BARCELONA', 'VALENCIA', 'GRANADA'];
    const equipments = ['EGATEL_MUX', 'SIEMENS_TX', 'HUAWEI_ROUTER', 'CISCO_SWITCH'];

    for (let i = 0; i < count; i += BATCH_SIZE) {
      const currentBatchCount = Math.min(BATCH_SIZE, count - i);
      const docs: any[] = [];
      
      for (let j = 0; j < currentBatchCount; j++) {
        const idNum = i + j + 1;
        const province = provinces[Math.floor(Math.random() * provinces.length)];
        const equipment = equipments[Math.floor(Math.random() * equipments.length)];
        docs.push({ 
          ID: `${province}.AUTO_${idNum.toString().padStart(6, '0')}`, 
          State: Math.random() > 0.1 ? '1' : '0', 
          meta: { 
            province, 
            equipment, 
            center: `${province.substring(0, 3)}${Math.floor(100000 + Math.random() * 900000)}`,
            severity: Math.floor(1 + Math.random() * 5).toString()
          } 
        });
      }

      const bulkLines = docs.flatMap(doc => [
        JSON.stringify({ index: { _index: esIndex, _id: doc.ID } }),
        JSON.stringify(doc),
      ]).join('\n') + '\n';

      const node = this.nodes[this.currentNodeIndex];
      const url = `${node.replace(/\/+$/, '')}/_bulk`; // No refresh for massive loads until the end
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/x-ndjson' },
        body: bulkLines
      });

      if (!res.ok) throw new Error(`Bulk error in batch ${i}`);
      seeded += currentBatchCount;
      this.logger.log(`Seeded ${seeded}/${count} documents...`);
    }

    // Final refresh to ensure all is visible
    await this.esRequest(`${esIndex}/_refresh`, 'POST');

    return { message: `Successfully seeded ${count} documents into ${esIndex}`, templateId, projectName };
  }
}
