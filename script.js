// Proxy principal + respaldos para saltar bloqueos de Filmaffinity/Rotten (método cutre por HTML)
const PROXY_URL = 'https://cantelar.twilightparadox.com/api-proxy';
const PROXY_TOKEN = 'Y31DbsxjRN9oq9DBJ3eZ16FBbFNAfM6cqAzNi1cSPAYSGL1NZq';
const OMDB_API_KEY = 'thewdb';
const OMDB_API_URL = 'https://www.omdbapi.com/';
// API espejo de FilmAffinity (RapidAPI "filmaffinity-data-api").
// FilmAffinity bloquea todo scraping directo con 403 Cloudflare (verificado:
// cantelar 403, allorigins 522, corsproxy 403, codetabs 522, translate 403).
// Consigue key gratis en https://rapidapi.com/superdatai-superdatai/api/filmaffinity-data-api
// y pégala aquí. Sin key se intenta scraping directo y si falla queda N/D sin bloquear al resto (async).
const RAPIDAPI_KEY = '';
const RAPIDAPI_HOST = 'filmaffinity-data-api.p.rapidapi.com';
// API local de scraping solo-FilmAffinity (dgongut/filmaffinity-api, Docker).
// Arráncala con: docker pull dgongut/filmaffinity-api && docker run -p 22049:22049 dgongut/filmaffinity-api
// Hace web scraping de filmaffinity.com desde tu máquina (IP residencial, pasa Cloudflare).
const FILMA_LOCAL_API = 'http://localhost:22049';

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
    const timeoutMs = opts.timeoutMs || 15000;
    const candidates = [
        { url: `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`, headers: { 'X-Proxy-Token': PROXY_TOKEN } },
        { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, headers: {} },
        { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, headers: {} },
        { url: `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`, headers: {} },
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
                if (!text || text.length < 800 || ltCount < 10 || /Just a moment|Attention Required|Cloudflare|Access Denied|cf-chl|Temporarily Offline|Internet Archive services are temporarily offline|origin connection.*fail|error code: 522|error code: 403/i.test(text)) {
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

// ---------- FILMAFFINITY - scraping dedicado (solo filmaffinity.com) + API espejo ----------
// 1) Scraping directo search.php -> filmXXX.html (HTML original).
// 2) Si hay 403 Cloudflare: Brave (vía proxy, no bloqueado) da el filmID,
//    y Wayback Machine sirve el HTML ORIGINAL archivado de filmaffinity.com (sin Cloudflare).
// 3) Si todo falla y RAPIDAPI_KEY configurada, usa API espejo RapidAPI.
async function fetchFilmaffinityViaAPI(title) {
    if (!RAPIDAPI_KEY) throw new Error('Sin RAPIDAPI_KEY');
    const headers = { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST };
    const searchUrl = `https://${RAPIDAPI_HOST}/v1/search?query=${encodeURIComponent(title)}`;
    const sRes = await fetch(searchUrl, { headers });
    if (!sRes.ok) throw new Error('RapidAPI search ' + sRes.status);
    const sData = await sRes.json();
    const list = Array.isArray(sData) ? sData : (sData.results || sData.data || sData.items || []);
    const first = list[0];
    if (!first) throw new Error('RapidAPI sin resultados');
    const filmId = first.film_id || first.filmId || first.id;
    const filmUrl = first.url;
    let detail = null;
    if (filmId) {
        const dRes = await fetch(`https://${RAPIDAPI_HOST}/v1/item/by-id?id=${encodeURIComponent(filmId)}`, { headers });
        if (dRes.ok) detail = await dRes.json();
    }
    if (!detail && filmUrl) {
        const dRes = await fetch(`https://${RAPIDAPI_HOST}/v1/item?url=${encodeURIComponent(filmUrl)}`, { headers });
        if (dRes.ok) detail = await dRes.json();
    }
    const rating = detail?.rating ?? first.rating ?? first.score;
    if (!rating || rating === '--') throw new Error('RapidAPI sin rating');
    return String(rating).replace('.', ',').slice(0, 4);
}
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
// Scraping plano: buscar la peli en FilmAffinity, localizar su ficha y pillar la nota.
async function fetchFilmaffinity(title) {
    return fetchFilmaffinityDirect(title);
}
// Scraping 100% FilmAffinity vía API local autoalojada (mismo HTML de cada peli).
async function fetchFilmaffinityViaLocal(title) {
    const searchUrl = `${FILMA_LOCAL_API}/api/search?query=${encodeURIComponent(title)}`;
    const sRes = await fetch(searchUrl);
    if (!sRes.ok) throw new Error('API local search HTTP ' + sRes.status + ' (¿docker en marcha?)');
    const list = await sRes.json();
    const arr = Array.isArray(list) ? list : (list.results || list.data || []);
    if (!arr.length) throw new Error('API local sin resultados');
    let pick = arr.find(x => x.rating && x.rating !== '--') || arr[0];
    if (pick.rating && pick.rating !== '--') {
        console.log('[Filma] local search rating', pick.rating);
        return String(pick.rating).replace('.', ',').slice(0, 4);
    }
    const id = pick.id || pick.filmId;
    if (!id) throw new Error('API local sin id ni rating');
    const dRes = await fetch(`${FILMA_LOCAL_API}/api/film?id=${encodeURIComponent(id)}`);
    if (!dRes.ok) throw new Error('API local film HTTP ' + dRes.status);
    const detail = await dRes.json();
    const rating = detail.rating;
    if (!rating || rating === '--') throw new Error('API local sin rating');
    console.log('[Filma] local detail rating', rating);
    return String(rating).replace('.', ',').slice(0, 4);
}
// Obtiene el filmID vía Brave search (no bloqueado) y el HTML ORIGINAL vía Wayback.
async function fetchFilmaIdViaBrave(title) {
    const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent('site:filmaffinity.com ' + title)}`;
    const html = await fetchHtmlWithFallback(searchUrl);
    const ids = [...new Set([...html.matchAll(/\/(?:es|en|us)\/film(\d+)\.html/gi)].map(m => m[1]))];
    console.log('[Filma] Brave IDs', ids.slice(0, 5).join(', '));
    if (!ids.length) throw new Error('Brave sin filmID para "' + title + '"');
    return ids[0];
}
async function fetchFilmaffinityViaWayback(title) {
    const filmId = await fetchFilmaIdViaBrave(title);
    // Sin API availability (da 429): Wayback redirige /web/<año>/ al snapshot más cercano.
    // Es el HTML ORIGINAL de filmaffinity.com archivado, web scraping puro sin API de pago.
    const stamps = ['2026', '2024', '2020'];
    let lastErr = null;
    for (const ts of stamps) {
        const snapUrl = `https://web.archive.org/web/${ts}id_/https://www.filmaffinity.com/es/film${filmId}.html`;
        console.log('[Filma] Wayback snapshot', snapUrl);
        try {
            let snapHtml = null;
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 12000);
                let r;
                try { r = await fetch(snapUrl, { signal: ctrl.signal }); }
                finally { clearTimeout(t); }
                if (!r.ok) throw new Error('HTTP ' + r.status);
                snapHtml = await r.text();
            } catch {
                snapHtml = await fetchHtmlWithFallback(snapUrl, { timeoutMs: 8000 });
            }
            if (!snapHtml || snapHtml.length < 800) throw new Error('Snapshot vacío');
            console.log('[Filma] snapshot len', snapHtml.length);
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

// ---------- ROTTEN - con API napi + fallback OMDb vivo ----------
async function fetchRotten(title) {
    const map = { 'el caballero oscuro': 'The Dark Knight', 'origen': 'Inception', 'interestelar': 'Interstellar' };
    const qTitle = map[title.trim().toLowerCase()] || title;
    const slugGuess = qTitle.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    let movieUrl = null;
    try {
        const apiUrl = `https://www.rottentomatoes.com/napi/search/all?query=${encodeURIComponent(qTitle)}`;
        const jsonTxt = await fetchHtmlWithFallback(apiUrl);
        const data = JSON.parse(jsonTxt);
        const movies = data.movies || data.results?.movies || data.items || [];
        const first = Array.isArray(movies) ? movies[0] : null;
        if (first && (first.url || first.vanityUrl || first.titleUrl)) {
            const u = first.url || first.vanityUrl || first.titleUrl;
            movieUrl = u.startsWith('http') ? u : 'https://www.rottentomatoes.com' + u;
            console.log('[Rotten] API encontró', movieUrl);
        } else {
            const alt = data.searchResults?.movies?.[0] || data.movieResults?.[0];
            if (alt && alt.url) movieUrl = 'https://www.rottentomatoes.com' + alt.url;
        }
    } catch(e) { console.warn('[Rotten] API search falló', e.message); }

    if (!movieUrl) {
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
    if (!movieUrl) movieUrl = `https://www.rottentomatoes.com/m/${slugGuess}`;
    console.log('[Rotten] movieUrl', movieUrl);
    const html = await fetchHtmlWithFallback(movieUrl);
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

function setLoading(isLoading, msg) {
    Object.values(cells).forEach(td => {
        if (isLoading) { td.textContent = '...'; td.classList.add('loading'); }
        else td.classList.remove('loading');
    });
    if (msg) titleCell.textContent = msg;
    btn.disabled = isLoading;
    btn.style.opacity = isLoading ? '0.6' : '1';
}
function fillTable(r) {
    cells.imdb.textContent = r.imdb || '—';
    cells.sensa.textContent = r.sensa || '—';
    cells.filma.textContent = r.filma || '—';
    cells.critic.textContent = r.critic || '—';
    cells.audience.textContent = r.audience || '—';
}

// Cada fuente pinta su td en cuanto resuelve, sin esperar a las demás.
// IMDb / Sensacine / critic intactos, solo cambia la orquestación a asíncrona.
function paintCell(td, value) {
    td.textContent = value || 'N/D';
    td.classList.remove('loading');
}
async function handleSearch() {
    const raw = input.value.trim();
    if (!raw) { titleCell.textContent = 'Escribe una película'; return; }
    titleCell.textContent = raw;
    btn.disabled = true;
    btn.style.opacity = '0.6';
    Object.values(cells).forEach(td => { td.textContent = '...'; td.classList.add('loading'); });

    let pending = 4;
    const done = () => {
        pending--;
        if (pending <= 0) { btn.disabled = false; btn.style.opacity = '1'; }
    };

    fetchIMDb(raw).catch(async e => {
        console.warn('IMDb scraping falló, fallback OMDb vivo:', e.message);
        const live = await fetchOMDbLive(raw).catch(() => null);
        if (live && live.imdb) return live.imdb;
        throw e;
    }).then(
        v => { paintCell(cells.imdb, v); console.log('IMDb OK:', v); },
        e => { paintCell(cells.imdb, 'N/D'); console.warn('IMDb falló:', e.message); }
    ).finally(done);

    fetchSensacine(raw).then(
        v => { paintCell(cells.sensa, v); console.log('Sensacine OK:', v); },
        e => { paintCell(cells.sensa, 'N/D'); console.warn('Sensacine falló:', e.message); }
    ).finally(done);

    fetchFilmaffinity(raw).then(
        v => { paintCell(cells.filma, v); console.log('Filmaffinity OK:', v); },
        e => { paintCell(cells.filma, 'N/D'); console.warn('Filmaffinity falló:', e.message); }
    ).finally(done);

    fetchRotten(raw).catch(async e => {
        console.warn('Rotten scraping falló, fallback OMDb vivo:', e.message);
        const live = await fetchOMDbLive(raw).catch(() => null);
        if (live && live.critic) return { critic: live.critic, audience: 'N/D' };
        throw e;
    }).then(
        r => {
            paintCell(cells.critic, r.critic);
            paintCell(cells.audience, r.audience);
            console.log('Rotten OK:', r);
        },
        e => {
            paintCell(cells.critic, 'N/D');
            paintCell(cells.audience, 'N/D');
            console.warn('Rotten falló:', e.message);
        }
    ).finally(done);
}

btn.addEventListener('click', handleSearch);
input.addEventListener('keydown', e=>{ if(e.key==='Enter') handleSearch(); });
