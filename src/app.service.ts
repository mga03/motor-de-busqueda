import { Injectable, Logger } from '@nestjs/common';
import fetch from 'node-fetch';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly couchUrl = process.env.COUCHDB_URL ?? 'http://localhost:5984';
  private readonly couchDb = process.env.COUCHDB_DB ?? 'service_type';
  private readonly esUrl = process.env.ELASTIC_ENDPOINT ?? 'http://localhost:9200';
  private readonly esApiKey = process.env.ELASTIC_API_KEY;

  async getFilters(templateId: string = 'icons_hpov') {
    const url = `${this.couchUrl}/${this.couchDb}/${templateId}`;
    this.logger.log(`Fetching filter doc from CouchDB: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) {
      this.logger.warn(`CouchDB request failed: ${resp.status} ${resp.statusText}, falling back to defaults.`);
      return { filters: ['meta.province', 'meta.center', 'meta.equipment', 'meta.severity'] };
    }
    const doc = (await resp.json()) as any;
    if (!Array.isArray(doc?.history)) {
      this.logger.warn('CouchDB document missing history array, falling back to defaults.');
      return { filters: ['meta.province', 'meta.center', 'meta.equipment', 'meta.severity'] };
    }
    return { filters: doc.history };
  }

  buildSearchQuery(filters: Record<string, any>, size = 20, searchAfter?: string[]) {
    const must: any[] = [];
    
    // Fixed filters: ID (partial search with wildcards) and State
    if (filters.ID) {
      // If the user didn't provide wildcards, add them for "partial match" behavior
      const queryValue = filters.ID.includes('*') ? filters.ID : `*${filters.ID}*`;
      must.push({ wildcard: { "ID": queryValue } });
      delete filters.ID;
    }
    
    if (filters.State) {
      must.push({ term: { "State": filters.State } });
      delete filters.State;
    }

    // Dynamic filters (meta fields)
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value == null || value === '') continue;
      must.push({ term: { [key]: value } });
    }

    const query: any = { bool: { must } };
    if (must.length === 0) query.bool.must = [{ match_all: {} }];

    const body: any = {
      size,
      query,
      sort: [{ ID: 'asc' }], // Essential for search_after tie-breaking
    };

    if (searchAfter && Array.isArray(searchAfter)) {
      body.search_after = searchAfter;
    }

    return body;
  }

  async search(templateId: string, projectName: string, filters: Record<string, any>, size = 20, searchAfter?: string[]) {
    const esIndex = `${templateId}.${projectName}`;
    const body = this.buildSearchQuery(filters, size, searchAfter);
    
    this.logger.log(`Searching index: ${esIndex} with query: ${JSON.stringify(body)}`);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.esApiKey) {
      headers['Authorization'] = `ApiKey ${this.esApiKey}`;
    }

    const resp = await fetch(`${this.esUrl}/${esIndex}/_search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Elasticsearch error: ${resp.status} ${resp.statusText} ${text}`);
    }

    const result = (await resp.json()) as any;
    const hits = result?.hits?.hits?.map((h: any) => ({ 
      id: h._id, 
      score: h._score, 
      source: h._source, 
      sort: h.sort 
    })) ?? [];

    return {
      took: result?.took,
      total: typeof result?.hits?.total === 'object' ? result.hits.total.value : result?.hits?.total,
      hits,
      search_after: hits.length > 0 ? hits[hits.length - 1].sort : undefined,
    };
  }

  async setupIndexAndSample(templateId: string, projectName: string) {
    const esIndex = `${templateId}.${projectName}`;
    const indexUrl = `${this.esUrl}/${esIndex}`;
    
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.esApiKey) {
      headers['Authorization'] = `ApiKey ${this.esApiKey}`;
    }

    const exists = await fetch(indexUrl, { method: 'HEAD', headers });
    if (!exists.ok) {
      await fetch(indexUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          mappings: {
            properties: {
              ID: { type: 'keyword' },
              State: { type: 'keyword' },
              meta: {
                properties: {
                  province: { type: 'keyword' },
                  center: { type: 'keyword' },
                  equipment: { type: 'keyword' },
                  severity: { type: 'keyword' },
                },
              },
            },
          },
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
          },
        }),
      });
    }

    const doc = {
      ID: 'BAZA.TX_PPAL_01',
      State: '1',
      meta: {
        province: 'GRANADA',
        center: 'GRA194001',
        equipment: 'EGATEL_MUX',
        severity: '1',
      },
    };

    await fetch(`${this.esUrl}/${esIndex}/_doc/${encodeURIComponent(doc.ID)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(doc),
    });

    return { message: `Index ${esIndex} and sample document ready`, doc };
  }

  async seedData(templateId: string, projectName: string, count: number = 50) {
    const esIndex = `${templateId}.${projectName}`;
    const provinces = ['SEVILLA', 'MADRID', 'BARCELONA', 'VALENCIA', 'GRANADA'];
    const equipments = ['EGATEL_MUX', 'SIEMENS_TX', 'HUAWEI_ROUTER', 'CISCO_SWITCH'];
    const states = ['1', '0'];
    const docs: any[] = [];

    for (let i = 1; i <= count; i++) {
      const province = provinces[Math.floor(Math.random() * provinces.length)];
      const equipment = equipments[Math.floor(Math.random() * equipments.length)];
      const state = states[Math.floor(Math.random() * states.length)];
      const id = `${province}.TX_${equipment.split('_')[0]}_${i.toString().padStart(2, '0')}`;
      
      docs.push({
        ID: id,
        State: state,
        meta: {
          province,
          equipment,
          center: `${province.substring(0, 3)}${Math.floor(100000 + Math.random() * 900000)}`,
          severity: Math.floor(1 + Math.random() * 5).toString(),
        }
      });
    }

    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
    if (this.esApiKey) {
      headers['Authorization'] = `ApiKey ${this.esApiKey}`;
    }

    const bulkLines: string[] = [];
    for (const doc of docs) {
      bulkLines.push(JSON.stringify({ index: { _index: esIndex, _id: doc.ID } }));
      bulkLines.push(JSON.stringify(doc));
    }
    const bulkBody = bulkLines.join('\n') + '\n';

    const resp = await fetch(`${this.esUrl}/_bulk`, {
      method: 'POST',
      headers,
      body: bulkBody,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Elasticsearch Bulk error: ${resp.status} ${text}`);
    }

    return { message: `Successfully seeded ${count} documents into ${esIndex}`, templateId, projectName };
  }
}
