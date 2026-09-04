// Proxy principal + 1 respaldo público (allorigins). El proxy propio es rápido
// y envía X-Proxy-Token; los demás solo entran si el propio falla.
const PROXY_URL = 'https://cantelar.twilightparadox.com/api-proxy';
const PROXY_TOKEN = 'Y31DbsxjRN9oq9DBJ3eZ16FBbFNAfM6cqAzNi1cSPAYSGL1NZq';
const OMDB_API_KEY = 'thewdb';
const OMDB_API_URL = 'https://www.omdbapi.com/';
const DEFAULT_TIMEOUT_MS = 12000;
// FilmAffinity bloquea IPs de datacenter con 403 Cloudflare (verificado).
// Se intenta scraping directo y si falla queda N/D sin bloquear al resto (async).

const input = document.getElementById('movieInput');
const btn = document.getElementById('searchBtn');
const titleCell = document.getElementById('movieTitle');
const cells = {
    imdb: document.getElementById('td-imdb'),
    sensa: document.getElementById('td-sensa'),
    filma: document.getElementById('td-filma'),
    critic: document.getElementById('td-critic'),
    audience: document.getElementById('td-audience')
};

async function fetchHtmlWithFallback(targetUrl, opts = {}) {
    const isApi = /omdbapi\.com|sg\.media-imdb\.com|suggestion|napi\/search|archive\.org\/wayback\/available/i.test(targetUrl);
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const candidates = [
        { url: `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, headers: { 'X-Proxy-Token': PROXY_TOKEN } },
        { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, headers: {} },
    ];
    let lastErr = null;
    for (const c of candidates) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            let res;
            try {
                res = await fetch(c.url, { headers: c.headers, signal: ctrl.signal });
            } finally {
                clearTimeout(t);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ct = res.headers.get('content-type') || '';
            let text;
            if (ct.includes('application/json') && c.url.includes(PROXY_URL)) {
                const j = await res.json();
                if (typeof j === 'string') text = j;
                else if (j.contents) text = j.contents;
                else if (j.data) text = typeof j.data === 'string' ? j.data : JSON.stringify(j.data);
                else if (j.html) text = j.html;
                else text = JSON.stringify(j);
            } else {
                text = await res.text();
            }
            if (!isApi) {
                const ltCount = (text.match(/</g) || []).length;
                // OJO: no usar "Cloudflare" a secas como señal de bloqueo: el HTML
                // válido de Wayback incluye el beacon cloudflareinsights (analytics).
                // Solo los marcadores de challenge/página de bloqueo indican 403 real.
                if (!text || text.length < 800 || ltCount < 10 || /Just a moment|Attention Required|challenge-platform|cf-chl|cf_chl|__cf_chl|Access Denied|Temporarily Offline|Internet Archive services are temporarily offline|origin connection.*fail|error code: 522|error code: 403/i.test(text)) {
                    throw new Error('Bloqueo/HTML vacío/error (' + text.length + ' chars, ' + ltCount + ' tags)');
                }
            } else {
                if (!text || text.length < 20) throw new Error('API vacía (' + text.length + ')');
            }
            console.log('[Proxy OK]', c.url.slice(0,60), '->', text.length);
            return text;
        } catch (e) {
            console.warn('[Proxy FAIL]', c.url.slice(0,60), e.message);
            lastErr = e;
        }
    }
    try {
        const r = await fetch(targetUrl);
        if (r.ok) return r.text();
    } catch {}
    throw lastErr || new Error('Todos los proxies fallaron para ' + targetUrl);
}
async function fetchJsonWithFallback(targetUrl) {
    const txt = await fetchHtmlWithFallback(targetUrl);
    try { return JSON.parse(txt); } catch (e) {
        console.warn('[fetchJson fallback] no es JSON, reintentando directo', e.message);
        const r = await fetch(targetUrl);
        if (!r.ok) throw new Error('JSON directo HTTP ' + r.status);
        return r.json();
    }
}
function toAbs(href, base) { try { return new URL(href, base).href; } catch { return href; } }
function parseHTML(html) { return new DOMParser().parseFromString(html, 'text/html'); }

async function fetchOMDbLive(title) {
    const map = { 'el caballero oscuro': 'The Dark Knight', 'origen': 'Inception', 'interestelar': 'Interstellar' };
    const q = map[title.trim().toLowerCase()] || title;
    const url = `${OMDB_API_URL}?t=${encodeURIComponent(q)}&apikey=${OMDB_API_KEY}`;
    let data;
    try { data = await fetchJsonWithFallback(url); }
    catch { const r = await fetch(url); data = await r.json(); }
    if (data.Response === 'False') throw new Error(data.Error);
    const imdb = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating.replace('.', ',') : null;
    const rotten = (data.Ratings || []).find(r => r.Source === 'Rotten Tomatoes');
    return { imdb, critic: rotten ? rotten.Value : null };
}

// ---------- FILMAFFINITY - search.php directo, fallback DDG + Wayback (evita Cloudflare) ----------
async function fetchFilmaffinityDirect(title) {
    // 1) Buscar la peli en FilmAffinity con lo escrito en el input
    console.log('[Filma] 1/3 buscando en filmaffinity:', title);
    const searchUrl = `https://www.filmaffinity.com/es/search.php?stext=${encodeURIComponent(title)}&stype=all`;
    const html = await fetchHtmlWithFallback(searchUrl, { timeoutMs: 8000 });
    console.log('[Filma] 1/3 OK, search len', html.length);
    const doc = parseHTML(html);
    // Si la búsqueda cae directo en la ficha, la nota ya está aquí
    let probe = doc.querySelector('#movie-rat-avg, #rat-avg, .avg-rating, [itemprop="ratingValue"]');
    if (probe && /\d/.test(probe.textContent)) {
        const m = probe.textContent.trim().replace('.', ',').match(/[0-9]+,[0-9]/);
        if (m) { console.log('[Filma] nota directa', m[0]); return m[0]; }
    }
    // 2) Coger la ficha de la peli (primer resultado)
    let link = doc.querySelector('.mc-title a[href*="/film"], a[href*="/es/film"], .se-it a');
    if (!link) {
        const cand = [...doc.querySelectorAll('a[href*="film"]')].find(a => /film\d+\.html/.test(a.getAttribute('href')||''));
        if (cand) link = cand;
    }
    let movieUrl = null;
    if (!link) {
        const m = html.match(/href="(\/es\/film\d+\.html[^"]*)"/) || html.match(/href="([^"]*film\d+\.html)"/);
        if (!m) throw new Error('Filmaffinity sin resultados para "'+title+'"');
        movieUrl = toAbs(m[1], 'https://www.filmaffinity.com');
    } else {
        movieUrl = toAbs(link.getAttribute('href'), 'https://www.filmaffinity.com');
    }
    console.log('[Filma] 2/3 ficha', movieUrl);
    // 3) Obtener la puntuación de la ficha y traerla aquí
    const detailHtml = await fetchHtmlWithFallback(movieUrl, { timeoutMs: 8000 });
    const rating = extractFilmaRating(detailHtml);
    console.log('[Filma] 3/3 puntuación', rating);
    return rating;
}
// Scraping plano: Bing RSS + Wayback PRIMERO (ruta rápida ~2s, evita Cloudflare),
// search.php directo solo como fallback (allorigins tarda 19s en dar 522).
async function fetchFilmaffinity(title) {
    try {
        return await fetchFilmaffinityViaWayback(title);
    } catch (e) {
        console.warn('[Filma] DDG+Wayback falló, probando directo:', e.message);
        return fetchFilmaffinityDirect(title);
    }
}
// filmID vía Bing RSS (XML ligero 5KB, no bloquea datacenters, trae el link
// https://www.filmaffinity.com/es/filmNNNNNN.html directo en <link>).
async function fetchFilmaIdViaDDG(title) {
    const rssUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent('site:filmaffinity.com ' + title)}`;
    const xml = await fetchHtmlWithFallback(rssUrl);
    const ids = [...new Set([...xml.matchAll(/filmaffinity\.com\/(?:es|en|us)\/film(\d+)\.html/gi)].map(m => m[1]))];
    if (!ids.length) throw new Error('Bing RSS sin filmID para "' + title + '"');
    console.log('[Filma] Bing RSS filmID', ids[0]);
    return ids[0];
}
async function fetchFilmaffinityViaWayback(title) {
    const filmId = await fetchFilmaIdViaDDG(title);
    // Wayback redirige /web/<año>/ al snapshot más cercano: HTML ORIGINAL archivado.
    const stamps = ['2024', '2023', '2020'];
    let lastErr = null;
    for (const ts of stamps) {
        const snapUrl = `https://web.archive.org/web/${ts}id_/https://www.filmaffinity.com/es/film${filmId}.html`;
        try {
            const snapHtml = await fetchHtmlWithFallback(snapUrl);
            return extractFilmaRating(snapHtml);
        } catch (e) {
            console.warn('[Filma] snapshot', ts, 'falló:', e.message);
            lastErr = e;
        }
    }
    throw lastErr || new Error('Wayback sin snapshot para film' + filmId);
}
function extractFilmaRating(detailHtml) {
    const detailDoc = parseHTML(detailHtml);
    const selectors = ['#movie-rat-avg', '#rat-avg', '.avg-rating', '.avgrat-box', '[itemprop="ratingValue"]', '.rat-avg', '#rat-avg-container'];
    for (const sel of selectors) {
        const el = detailDoc.querySelector(sel);
        if (el && /\d/.test(el.textContent)) {
            const m = el.textContent.trim().replace('.', ',').match(/[0-9]+,[0-9]/);
            if (m) { console.log('[Filma] selector', sel, m[0]); return m[0]; }
        }
    }
    let m = detailHtml.match(/"ratingValue"\s*:\s*"?([0-9]\.[0-9])"?/);
    if (m) return m[1].replace('.', ',');
    m = detailHtml.match(/avg[_-]?rating[^0-9]*([0-9][.,][0-9])/i);
    if (m) return m[1].replace('.', ',');
    throw new Error('Filmaffinity nota no encontrada');
}

// ---------- SENSACINE ----------
async function fetchSensacine(title) {
    const searchUrl = `https://www.sensacine.com/buscar/?q=${encodeURIComponent(title)}`;
    const searchHtml = await fetchHtmlWithFallback(searchUrl);
    const searchDoc = parseHTML(searchHtml);
    let directNote = searchDoc.querySelector('.stareval-note, [itemprop="ratingValue"]');
    if (directNote && /\d/.test(directNote.textContent) && searchHtml.includes('stareval')) {
        let v = directNote.textContent.trim().replace('.', ',').match(/[0-9],[0-9]/)?.[0] || directNote.textContent.trim().slice(0,4);
        if (v) return v + ' / 5';
    }
    let link = searchDoc.querySelector('a[href*="/peliculas/pelicula-"]');
    if (!link) link = [...searchDoc.querySelectorAll('a[href*="pelicula"]')].find(a=>a.href.includes('/peliculas/pelicula-'));
    if (!link) throw new Error('Sensacine sin resultados');
    const movieUrl = toAbs(link.getAttribute('href'), 'https://www.sensacine.com');
    const html = await fetchHtmlWithFallback(movieUrl);
    const doc = parseHTML(html);
    const notes = [...doc.querySelectorAll('.stareval-note')];
    if (notes.length) {
        const vals = notes.map(n=>n.textContent.trim().replace('.', ',').match(/[0-9],[0-9]/)?.[0] || n.textContent.trim()).filter(v=>/\d/.test(v));
        if (vals.length) return vals[0] + ' / 5';
    }
    let m = html.match(/"pressRating"\s*:\s*([0-9.]+)/) || html.match(/"ratingValue"\s*:\s*"?([0-9][.,][0-9])"?/);
    if (m) return m[1].replace('.', ',') + ' / 5';
    throw new Error('Sensacine nota no encontrada');
}

// ---------- IMDB ----------
async function fetchIMDb(title) {
    try {
        const q = title.trim().toLowerCase();
        if (q.length >= 2) {
            const sugUrl = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q[0])}/${encodeURIComponent(q)}.json`;
            const sugTxt = await fetchHtmlWithFallback(sugUrl);
            const sug = JSON.parse(sugTxt);
            const first = sug.d && sug.d[0] && sug.d[0].id;
            if (first) {
                const movieUrl = `https://www.imdb.com/title/${first}/`;
                const html = await fetchHtmlWithFallback(movieUrl);
                const m = html.match(/"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*"?([0-9.]+)"?/);
                if (m) return m[1].replace('.', ',').slice(0,4);
            }
        }
    } catch(e) { console.warn('IMDb sugerencias falló', e.message); }
    const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(title)}&s=tt&ttype=ft`;
    const searchHtml = await fetchHtmlWithFallback(searchUrl);
    const searchDoc = parseHTML(searchHtml);
    const link = searchDoc.querySelector('a[href*="/title/tt"]');
    if (!link) throw new Error('IMDb sin resultados');
    const id = (link.getAttribute('href').match(/tt\d+/)||[])[0];
    if (!id) throw new Error('IMDb ID no encontrado');
    const movieUrl = `https://www.imdb.com/title/${id}/`;
    const html = await fetchHtmlWithFallback(movieUrl);
    const doc = parseHTML(html);
    let el = doc.querySelector('[data-testid="hero-rating-bar__aggregate-rating__score"] span');
    let rating = el ? el.textContent.trim() : null;
    if (!rating || !/\d/.test(rating)) {
        const m = html.match(/"aggregateRating"\s*:\s*\{[^}]*"ratingValue"\s*:\s*"?([0-9.]+)"?/) || html.match(/ratingValue[^0-9]*([0-9]\.[0-9])/);
        if (m) rating = m[1];
    }
    if (!rating) throw new Error('IMDb rating no encontrado');
    return rating.replace('.', ',').slice(0,4).split('/')[0];
}

// ---------- ROTTEN - slug directo + /search, fallback OMDb vivo ----------
// El napi/search da 401 desde datacenter y allorigins tarda 12s: se omite.
// /m/<slug> responde 200 en ~600ms vía proxy; /search lo corrige si el slug falla.
async function fetchRotten(title) {
    const map = { 'el caballero oscuro': 'The Dark Knight', 'origen': 'Inception', 'interestelar': 'Interstellar' };
    const qTitle = map[title.trim().toLowerCase()] || title;
    const slugGuess = qTitle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    let movieUrl = `https://www.rottentomatoes.com/m/${slugGuess}`;
    let html = null;
    let lastErr = null;
    try {
        html = await fetchHtmlWithFallback(movieUrl);
        if (!/score-board|tomatometerScore|audienceScore/i.test(html)) throw new Error('Slug sin scores');
        console.log('[Rotten] slug directo OK', movieUrl);
    } catch (e) {
        console.warn('[Rotten] slug directo falló, probando /search:', e.message);
        lastErr = e;
        movieUrl = null;
    }

    if (!html) {
        try {
            const searchUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(qTitle)}`;
            const searchHtml = await fetchHtmlWithFallback(searchUrl);
            // No coger el primer a[href*="/m/"]: los 3 primeros son trending (coyote_vs_acme, buddy_2026...).
            // Recoger todos los /m/ únicos y elegir el que mejor casa con la búsqueda.
            const all = [...new Set([...searchHtml.matchAll(/href="(\/m\/[a-z0-9_]+)/gi)].map(m => m[1]))];
            console.log('[Rotten] candidatos', all.slice(0, 12).join(', '));
            let pick = all.find(s => s === `/m/${slugGuess}`)
                || all.find(s => s.includes(slugGuess) || slugGuess.includes(s.replace('/m/', '')))
                || (() => {
                    const words = slugGuess.split('_').filter(w => w.length > 2);
                    return all.find(s => words.length && words.every(w => s.includes(w)));
                })()
                || all.find(s => { const slug = s.replace('/m/', ''); const words = slugGuess.split('_'); return words.some(w => w.length > 3 && slug.includes(w)); });
            if (pick) movieUrl = 'https://www.rottentomatoes.com' + pick;
            if (!movieUrl) {
                let a = parseHTML(searchHtml).querySelectorAll('a[href*="/m/"]');
                // saltar los 3 trending y coger el 4º si existe
                const cand = a.length > 3 ? a[3] : a[0];
                if (cand) movieUrl = toAbs(cand.getAttribute('href'), 'https://www.rottentomatoes.com');
            }
            if (movieUrl) console.log('[Rotten] search eligió', movieUrl);
        } catch {}
    }
    if (!movieUrl) throw lastErr || new Error('Rotten sin URL para "' + qTitle + '"');
    console.log('[Rotten] movieUrl', movieUrl);
    if (!html) html = await fetchHtmlWithFallback(movieUrl);
    const doc = parseHTML(html);
    let critic = null, audience = null;
    const board = doc.querySelector('score-board');
    if (board) {
        const c = board.getAttribute('tomatometerscore') || board.getAttribute('tomatometerScore');
        const a = board.getAttribute('audiencescore') || board.getAttribute('audienceScore') || board.getAttribute('audience-score');
        if (c && /^\d{1,3}$/.test(c)) critic = c + '%';
        if (a && /^\d{1,3}$/.test(a)) audience = a + '%';
        console.log('[Rotten] board', c, a);
    }
    if (!critic || !audience) {
        const scripts = [...doc.querySelectorAll('script')].map(s=>s.textContent).join(' ') + ' ' + html;
        if (!critic) {
            let m = scripts.match(/"tomatometerScore"\s*:\s*\{\s*"value"\s*:\s*([0-9]{1,3})/) || scripts.match(/"criticsScore"\s*:\s*\{[^}]*"score"\s*:\s*"?([0-9]{1,3})/) || scripts.match(/"criticsScore"\s*:\s*([0-9]{1,3})/);
            if (m) critic = m[1] + '%';
        }
        if (!audience) {
            let m = scripts.match(/"audienceScore"\s*:\s*\{[^}]*"score"\s*:\s*"?([0-9]{1,3})/) || scripts.match(/"audienceScore"\s*:\s*\{\s*"value"\s*:\s*([0-9]{1,3})/) || scripts.match(/"audienceScore"\s*:\s*([0-9]{1,3})/);
            if (m) { audience = m[1] + '%'; console.log('[Rotten] audience script', audience); }
        }
    }
    if (!critic && !audience) throw new Error('Rotten no encontrado en ' + movieUrl);
    return { critic: critic || 'N/D', audience: audience || 'N/D' };
}

// Cada fuente pinta su td en cuanto resuelve, sin esperar a las demás.
function paintCell(td, value) {
    td.textContent = value || 'N/D';
    td.classList.remove('loading');
}
let currentSearchId = 0;
async function handleSearch() {
    const raw = input.value.trim().replace(/\s+/g, ' ');
    if (!raw) { titleCell.textContent = 'Escribe una película'; return; }
    if (raw.length > 100) { titleCell.textContent = 'Título demasiado largo (máx 100)'; return; }
    if (btn.disabled) return; // evita doble submit mientras hay búsqueda en curso
    const searchId = ++currentSearchId;
    const isStale = () => searchId !== currentSearchId;
    titleCell.textContent = raw.toUpperCase();
    btn.disabled = true;
    btn.style.opacity = '0.6';
    Object.values(cells).forEach(td => { td.textContent = '...'; td.classList.add('loading'); });

    const finish = () => {
        if (!isStale()) { btn.disabled = false; btn.style.opacity = '1'; }
    };

    const tasks = [
        fetchIMDb(raw).catch(async e => {
            console.warn('IMDb scraping falló, fallback OMDb vivo:', e.message);
            const live = await fetchOMDbLive(raw).catch(() => null);
            if (live && live.imdb) return live.imdb;
            throw e;
        }).then(
            v => { if (!isStale()) paintCell(cells.imdb, v); },
            e => { if (!isStale()) paintCell(cells.imdb, 'N/D'); console.warn('IMDb falló:', e.message); }
        ),

        fetchSensacine(raw).then(
            v => { if (!isStale()) paintCell(cells.sensa, v); },
            e => { if (!isStale()) paintCell(cells.sensa, 'N/D'); console.warn('Sensacine falló:', e.message); }
        ),

        fetchFilmaffinity(raw).then(
            v => { if (!isStale()) paintCell(cells.filma, v); },
            e => { if (!isStale()) paintCell(cells.filma, 'N/D'); console.warn('Filmaffinity falló:', e.message); }
        ),

        fetchRotten(raw).catch(async e => {
            console.warn('Rotten scraping falló, fallback OMDb vivo:', e.message);
            const live = await fetchOMDbLive(raw).catch(() => null);
            if (live && live.critic) return { critic: live.critic, audience: 'N/D' };
            throw e;
        }).then(
            r => {
                if (isStale()) return;
                paintCell(cells.critic, r.critic);
                paintCell(cells.audience, r.audience);
            },
            e => {
                if (isStale()) return;
                paintCell(cells.critic, 'N/D');
                paintCell(cells.audience, 'N/D');
                console.warn('Rotten falló:', e.message);
            }
        ),
    ];
    await Promise.allSettled(tasks);
    finish();
}

btn.addEventListener('click', handleSearch);
input.addEventListener('keydown', e=>{ if(e.key==='Enter') handleSearch(); });
