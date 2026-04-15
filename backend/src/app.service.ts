import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly couchUrl = process.env.COUCHDB_URL ?? 'http://localhost:5984';
  private readonly couchDb = process.env.COUCHDB_DB ?? 'service_type';

  private readonly nodes = (process.env.ELASTIC_NODES || 'http://localhost:9200').split(',');
  private readonly user = process.env.ELASTIC_USER;
  private readonly password = process.env.ELASTIC_PASSWORD;
  private readonly auth = this.user ? Buffer.from(`${this.user}:${this.password}`).toString('base64') : null;

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
            'Content-Type': 'application/json',
          },
        };

        if (this.auth) {
          options.headers['Authorization'] = `Basic ${this.auth}`;
        }

        // Native fetch SSL bypass trick for Node 18+ (only if https)
        if (url.startsWith('https')) {
          const undici = require('undici');
          options.dispatcher = new undici.Agent({
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

  buildSearchQuery(filters: Record<string, any>, size = 100, from = 0, searchAfter?: string[]) {
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
      from,
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort: [{ ID: 'asc' }],
    };
    if (searchAfter) body.search_after = searchAfter;
    return body;
  }

  async search(templateId: string, projectName: string, filters: Record<string, any>, size = 100, from = 0, searchAfter?: string[]) {
    const esIndex = `${templateId}.${projectName}`;
    const body = this.buildSearchQuery(filters, size, from, searchAfter);

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
    
    // El proceso de seeding se ejecuta en segundo plano para no bloquear al usuario
    this.runBackgroundSeeding(templateId, projectName, count);

    return { 
      message: `Generando ${count.toLocaleString()} registros... Los primeros resultados ya están disponibles.`, 
      templateId, 
      projectName 
    };
  }

  private async runBackgroundSeeding(templateId: string, projectName: string, count: number) {
    const esIndex = `${templateId}.${projectName}`;
    const BATCH_SIZE = 1000;
    let seeded = 0;

    const provinces = ['SEVILLA', 'MADRID', 'BARCELONA', 'VALENCIA', 'GRANADA'];
    const equipments = ['EGATEL_MUX', 'SIEMENS_TX', 'HUAWEI_ROUTER', 'CISCO_SWITCH'];

    try {
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
        const url = `${node.replace(/\/+$/, '')}/_bulk`;
        
        await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Basic ${this.auth}`, 'Content-Type': 'application/x-ndjson' },
          body: bulkLines
        });

        seeded += currentBatchCount;
        if (seeded % 5000 === 0 || seeded === count) {
          this.logger.log(`[Background Seed] ${seeded}/${count} documents into ${esIndex}...`);
        }
      }

      await this.esRequest(`${esIndex}/_refresh`, 'POST');
      this.logger.log(`[Background Seed] Completed! ${count} documents added to ${esIndex}`);
    } catch (error) {
      this.logger.error(`[Background Seed] Error seeding data: ${error.message}`);
    }
  }
}
