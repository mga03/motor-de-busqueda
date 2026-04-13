import { useEffect, useState } from 'react';
import './App.css';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

function App() {
  const [templateId, setTemplateId] = useState('icons_hpov');
  const [projectName, setProjectName] = useState('hpov_proyect');
  const [filters, setFilters] = useState([]);
  const [filterValues, setFilterValues] = useState({ ID: '', State: '' });
  const [results, setResults] = useState([]);
  const [searchAfter, setSearchAfter] = useState(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  // Normaliza un filtro a { label, attrib } independientemente del formato recibido
  const normalizeFilter = (f) => {
    if (typeof f === 'string') return { label: f.replace('meta.', ''), attrib: f.replace('meta.', '') };
    const attrib = f.attrib?.replace('meta.', '') || f.attrib;
    return { label: f.label || attrib, attrib };
  };

  // Load configuration/filters from CouchDB (via Backend)
  const loadConfig = async () => {
    setLoading(true);
    setStatus('Cargando configuración...');
    try {
      const res = await fetch(`${API_BASE}/init?template_id=${templateId}`);
      if (!res.ok) throw new Error('Error al conectar con el backend');
      const data = await res.json();

      // Sincronización definitiva: usamos data.history.filters tal como indica el backend
      const rawFilters = data.history?.filters || [];
      const normalized = rawFilters.map(normalizeFilter);
      setFilters(normalized);

      // Reset dynamic filter values pero conserva ID y State
      const newValues = { ID: filterValues.ID, State: filterValues.State };
      normalized.forEach(f => { if (newValues[f.attrib] === undefined) newValues[f.attrib] = ''; });
      setFilterValues(newValues);
      setStatus(`Configuración cargada — ${normalized.length} filtros activos.`);
    } catch (error) {
      setStatus('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const onSearch = async (append = false) => {
    setLoading(true);
    setStatus('Buscando en Elasticsearch...');
    const payload = {
      template_id: templateId,
      project_name: projectName,
      filters: Object.fromEntries(
        Object.entries(filterValues).filter(([, v]) => v?.toString().trim() !== '')
      ),
      size: 20,
      search_after: append ? searchAfter : undefined,
    };

    try {
      const res = await fetch(`${API_BASE}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Error del servidor (${res.status})`);
      
      setResults(append ? [...results, ...data.hits] : data.hits);
      setSearchAfter(data.search_after || null);
      setStatus(`Resultados: ${data.total}`);
    } catch (error) {
      if (error.message === 'Failed to fetch') {
        setStatus('⚠️ No se puede conectar con el Backend (localhost:3000). ¿Está arrancado?');
      } else {
        setStatus('⚠️ ' + error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const onSetup = async () => {
    setStatus('Generando índice y datos iniciales...');
    try {
      const res = await fetch(`${API_BASE}/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId, project_name: projectName }),
      });
      const data = await res.json();
      setStatus(data.message);
      onSearch(false);
    } catch (error) {
      setStatus('⚠️ ' + error.message);
    }
  };

  const [seedCount, setSeedCount] = useState(50);

  const onSeed = async () => {
    setStatus(`Generando ${seedCount} documentos de prueba...`);
    try {
      const res = await fetch(`${API_BASE}/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId, project_name: projectName, count: seedCount }),
      });
      const data = await res.json();
      setStatus(data.message);
      onSearch(false);
    } catch (error) {
      setStatus('⚠️ ' + error.message);
    }
  };

  return (
    <div className="container">
      <header className="main-header">
        <div className="logo-section">
          <h1>Service Engine</h1>
          <span className="badge">v2.0 Beta</span>
        </div>
        <div className="project-selector">
          <div className="input-group">
            <label>Template ID</label>
            <input value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
          </div>
          <div className="input-group">
            <label>Proyecto</label>
            <select value={projectName} onChange={(e) => setProjectName(e.target.value)}>
              <option value="hpov_proyect">hpov_proyect</option>
              <option value="factory_v1">factory_v1</option>
              <option value="demo_test">demo_test</option>
            </select>
          </div>
          <button onClick={loadConfig} className="btn-icon" title="Recargar filtros">🔄</button>
        </div>
      </header>

      <main className="dashboard">
        <aside className="filters-panel">
          <div className="panel-header">
            <h2>Filtros</h2>
            <button onClick={() => setFilterValues({ ID: '', State: '' })} className="btn-link">Limpiar</button>
          </div>
          
          <div className="filters-scroll">
            <div className="filter-item highlight">
              <label>Búsqueda ID (Wildcard)</label>
              <div className="search-box">
                <input 
                  value={filterValues.ID} 
                  onChange={(e) => setFilterValues(p => ({...p, ID: e.target.value}))}
                  placeholder="Ej: BAZA*"
                  className="input-id"
                />
                <span className="search-icon">🔍</span>
              </div>
            </div>

            <div className="filter-item">
              <label>Estado</label>
              <select 
                value={filterValues.State} 
                onChange={(e) => setFilterValues(p => ({...p, State: e.target.value}))}
              >
                <option value="">Todos</option>
                <option value="1">Activo (1)</option>
                <option value="0">Inactivo (0)</option>
              </select>
            </div>

            <div className="divider">Atributos Dinámicos</div>

            {filters.map(f => (
              <div className="filter-item" key={f.attrib}>
                <label>{f.label || f.attrib}</label>
                <input 
                  value={filterValues[f.attrib] || ''} 
                  onChange={(e) => setFilterValues(p => ({...p, [f.attrib]: e.target.value}))}
                  placeholder={`Filtrar ${f.label || f.attrib.split('.').pop()}...`}
                />
              </div>
            ))}
          </div>

          <div className="panel-footer">
            <button onClick={() => onSearch(false)} disabled={loading} className="btn-primary">
              {loading ? 'Buscando...' : 'Aplicar Filtros'}
            </button>
            <div className="btn-group-v">
              <div className="seed-control">
                <input 
                  type="number" 
                  value={seedCount} 
                  onChange={(e) => setSeedCount(parseInt(e.target.value) || 1)}
                  className="input-mini"
                  min="1"
                  max="500000"
                />
                <button onClick={onSeed} className="btn-outline">Generar Datos</button>
              </div>
              <button onClick={onSetup} className="btn-outline mini">Reset Index</button>
            </div>
          </div>
        </aside>

        <section className="results-panel">
          <div className="results-header">
            <div className="status-bar">{status}</div>
          </div>

          <div className="results-grid">
            {results.length === 0 ? (
              <div className="empty-state">
                <div className="icon">🔍</div>
                <h3>Sin resultados</h3>
                <p>Ajusta los filtros o inicializa el índice para empezar.</p>
              </div>
            ) : (
              results.map((item) => (
                <div className="card" key={item.id}>
                  <div className="card-header">
                    <span className="id-text">{item.source?.ID || item.id}</span>
                    <span className={`status-pill ${item.source?.State === '1' ? 'Active' : 'Inactive'}`}>
                      {item.source?.State === '1' ? 'Activo' : 'Inactivo'}
                    </span>
                  </div>
                  <div className="card-content">
                    <div className="meta-grid">
                      {Object.entries(item.source?.meta || {}).map(([k, v]) => (
                        <div className="meta-badge" key={k}>
                          <span className="meta-k">{k}</span>
                          <span className="meta-v">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          {searchAfter && (
            <div className="load-more">
              <button onClick={() => onSearch(true)} disabled={loading} className="btn-more">
                Cargar más documentos
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
