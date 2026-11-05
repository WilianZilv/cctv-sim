// Full-screen map to choose where the scene is generated: search an address or
// click a point, then confirm. Mapbox GL is loaded on first use.
import 'mapbox-gl/dist/mapbox-gl.css';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const CSS = `
#mp { position: fixed; inset: 0; z-index: 3000; background: #0b0c0e; display: none; }
#mp.open { display: block; }
#mp .mp-map { position: absolute; inset: 0; }
#mp .mp-bar { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; gap: 8px; align-items: center; z-index: 2; pointer-events: none; }
#mp .mp-bar > * { pointer-events: auto; }
#mp input { flex: 0 1 420px; height: 36px; border-radius: 8px; border: 1px solid #3a3f47; background: #15171b; color: #e6e8eb; padding: 0 12px; font: 14px system-ui, sans-serif; outline: none; }
#mp input:focus { border-color: #5b8def; }
#mp button { height: 36px; border-radius: 8px; border: 1px solid #3a3f47; background: #1d2026; color: #e6e8eb; padding: 0 14px; font: 13px system-ui, sans-serif; cursor: pointer; }
#mp button:hover { background: #262a31; }
#mp button.primary { background: #2f6fe0; border-color: #2f6fe0; color: #fff; }
#mp button.primary:hover { background: #3a7bf0; }
#mp button:disabled { opacity: 0.45; cursor: default; }
#mp .mp-results { position: absolute; top: 54px; left: 12px; width: 420px; max-width: calc(100% - 24px); background: #15171b; border: 1px solid #3a3f47; border-radius: 8px; overflow: hidden; z-index: 3; display: none; }
#mp .mp-results div { padding: 8px 12px; color: #d4d7dc; font: 13px system-ui, sans-serif; cursor: pointer; border-bottom: 1px solid #23262c; }
#mp .mp-results div:hover { background: #1f232a; }
#mp .mp-info { position: absolute; left: 12px; bottom: 34px; z-index: 2; background: rgba(15,17,20,0.88); color: #cfd3d9; font: 13px system-ui, sans-serif; padding: 10px 12px; border-radius: 8px; border: 1px solid #2c3036; max-width: 460px; line-height: 1.5; }
#mp .mp-spacer { flex: 1; }
`;

export class MapPicker {
  constructor(onPick) {
    this.onPick = onPick;
    this.el = document.createElement('div');
    this.el.id = 'mp';
    this.el.innerHTML = `
      <style>${CSS}</style>
      <div class="mp-map"></div>
      <div class="mp-bar">
        <input type="text" placeholder="Buscar endereço, bairro ou cidade" />
        <button data-act="style">Satélite</button>
        <div class="mp-spacer"></div>
        <button data-act="random">Local aleatório</button>
        <button data-act="close">Fechar</button>
        <button data-act="go" class="primary" disabled>Gerar cena aqui</button>
      </div>
      <div class="mp-results"></div>
      <div class="mp-info">Clique no mapa para escolher onde instalar a câmera. A cena é montada na rua mais próxima do ponto.</div>`;
    document.body.appendChild(this.el);
    this.input = this.el.querySelector('input');
    this.results = this.el.querySelector('.mp-results');
    this.info = this.el.querySelector('.mp-info');
    this.goBtn = this.el.querySelector('[data-act="go"]');
    this.styleBtn = this.el.querySelector('[data-act="style"]');
    this.picked = null;
    this.el.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (act === 'close') this.close();
      if (act === 'go' && this.picked) { this.close(); this.onPick(this.picked); }
      if (act === 'random') { this.close(); this.onPick(null); }
      if (act === 'style') this.toggleStyle();
    });
    let timer = null;
    this.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.search(), 300); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); this.search(true); }
      if (e.key === 'Escape') this.close();
      e.stopPropagation();
    });
    window.addEventListener('keydown', (e) => { if (this.isOpen && e.key === 'Escape') this.close(); });
  }

  get isOpen() { return this.el.classList.contains('open'); }

  async open(current) {
    this.el.classList.add('open');
    if (!this.map) {
      const mapboxgl = (await import('mapbox-gl')).default;
      this.mapboxgl = mapboxgl;
      mapboxgl.accessToken = TOKEN;
      this.satellite = false;
      this.map = new mapboxgl.Map({
        container: this.el.querySelector('.mp-map'),
        style: 'mapbox://styles/mapbox/streets-v12',
        center: current ? [current.lon, current.lat] : [-46.63, -23.55],
        zoom: current ? 17 : 11,
        attributionControl: true,
      });
      this.map.addControl(new mapboxgl.NavigationControl({ visualizePitch: false }), 'bottom-right');
      this.map.on('click', (e) => this.pick(e.lngLat.lat, e.lngLat.lng));
      this.marker = new mapboxgl.Marker({ color: '#2f6fe0' });
      this.here = new mapboxgl.Marker({ color: '#e0a02f', scale: 0.8 });
    } else {
      this.map.resize();
      if (current) this.map.jumpTo({ center: [current.lon, current.lat], zoom: Math.max(this.map.getZoom(), 16) });
    }
    if (current) this.here.setLngLat([current.lon, current.lat]).addTo(this.map);
    this.input.focus();
  }

  close() {
    this.el.classList.remove('open');
    this.results.style.display = 'none';
  }

  pick(lat, lon, label = '') {
    this.picked = { lat, lon };
    this.marker.setLngLat([lon, lat]).addTo(this.map);
    this.goBtn.disabled = false;
    this.info.textContent = `${label ? label + ' · ' : ''}${lat.toFixed(5)}, ${lon.toFixed(5)}. Confirme em "Gerar cena aqui" ou clique em outro ponto.`;
  }

  toggleStyle() {
    this.satellite = !this.satellite;
    this.map.setStyle(this.satellite ? 'mapbox://styles/mapbox/satellite-streets-v12' : 'mapbox://styles/mapbox/streets-v12');
    this.styleBtn.textContent = this.satellite ? 'Mapa' : 'Satélite';
  }

  async search(jump = false) {
    const q = this.input.value.trim();
    if (q.length < 3) { this.results.style.display = 'none'; return; }
    const c = this.map?.getCenter();
    const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=br&language=pt&limit=6${c ? `&proximity=${c.lng},${c.lat}` : ''}&access_token=${TOKEN}`;
    let feats = [];
    try { feats = (await (await fetch(url)).json()).features || []; } catch { /* offline */ }
    this.results.innerHTML = '';
    for (const f of feats) {
      const d = document.createElement('div');
      d.textContent = f.properties.full_address || f.properties.name;
      d.onclick = () => this.goTo(f);
      this.results.appendChild(d);
    }
    this.results.style.display = feats.length ? 'block' : 'none';
    if (jump && feats[0]) this.goTo(feats[0]);
  }

  goTo(f) {
    const [lon, lat] = f.geometry.coordinates;
    const street = ['address', 'street'].includes(f.properties.feature_type);
    this.map.flyTo({ center: [lon, lat], zoom: street ? 18 : 15, speed: 2 });
    this.results.style.display = 'none';
    if (street) this.pick(lat, lon, f.properties.name);
  }
}
