"use strict";

const PROVIDER_NAME = "Enma";
const TMDB_API_URL = "https://api.themoviedb.org/3";
const TMDB_API_KEY = "307b7b8ef035c6aa336900aef4e203bd";
const API_BASE = "https://api.enma.lol/api";
const ORIGIN_URL = "https://megaplay.buzz";
const CDN_BASE = "https://1oe.lostproject.club/anime/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const API_HEADERS = {
  "User-Agent": USER_AGENT,
  "Origin": "https://www.enma.lol",
  "Referer": "https://www.enma.lol/",
  "Accept": "application/json,text/plain,*/*",
};
const ORIGIN_HEADERS = {
  "User-Agent": USER_AGENT,
  "Referer": `${ORIGIN_URL}/`,
  "Origin": ORIGIN_URL,
};

const KEY_FRAGS = [
  {
    lo: new Uint8Array([176, 171, 82, 118, 28, 5, 235, 233, 124, 153, 171, 44, 44, 35, 35, 5]),
    hi: new Uint8Array([88, 98, 115, 15, 137, 251, 164, 174, 58, 103, 183, 112, 68, 156, 204, 236]),
  },
  {
    lo: new Uint8Array([164, 211, 65, 22, 100, 5, 36, 23, 207, 147, 15, 58, 101, 240, 203, 99]),
    hi: new Uint8Array([174, 168, 94, 34, 124, 146, 133, 217, 206, 144, 202, 28, 100, 25, 11, 75]),
  },
  {
    lo: new Uint8Array([207, 188, 181, 104, 32, 24, 64, 34, 111, 98, 187, 115, 186, 86, 24, 60]),
    hi: new Uint8Array([238, 21, 99, 156, 176, 92, 120, 11, 230, 47, 144, 116, 167, 39, 9, 192]),
  },
  {
    lo: new Uint8Array([39, 19, 209, 11, 162, 213, 193, 191, 88, 69, 26, 201, 33, 231, 119, 81]),
    hi: new Uint8Array([9, 219, 247, 207, 209, 223, 61, 114, 23, 60, 37, 255, 161, 22, 207, 162]),
  },
];

let _encKey = null;
let _cryptoKeyProm = null;

function deriveEncKey() {
  if (_encKey) return _encKey;

  const out = new Uint8Array(32);
  for (const { lo, hi } of KEY_FRAGS) {
    for (let i = 0; i < 16; i++) {
      out[i] ^= lo[i] ^ ((0x5b + i * 13) % 256);
      out[i + 16] ^= hi[i] ^ ((0x5b + (i + 16) * 13) % 256);
    }
  }

  return (_encKey = out);
}

function getCryptoKey() {
  if (!_cryptoKeyProm) {
    _cryptoKeyProm = crypto.subtle.importKey("raw", deriveEncKey(), { name: "AES-GCM" }, false, ["decrypt"],);
  }
  return _cryptoKeyProm;
}

async function decryptApiResponse(body) {
  try {
    const cleaned = String(body ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
    const raw = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0));

    if (raw.length < 28) return null;

    const nonce = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const ct = raw.slice(28);

    const payload = new Uint8Array(ct.length + 16);
    payload.set(ct);
    payload.set(tag, ct.length);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      await getCryptoKey(),
      payload,
    );

    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

async function httpGet(url, headers) {
  try {
    const res = await fetch(url, { headers });
    return res.ok ? res.text() : null;
  } catch {
    return null;
  }
}

async function apiRequest(path) {
  const text = await httpGet(`${API_BASE}${path}`, API_HEADERS);
  if (!text) return null;
  return decryptApiResponse(text.trim());
}

async function fetchTmdbType(tmdbId, type) {
  try {
    const url = `${TMDB_API_URL}/${type}/${tmdbId}` + `?api_key=${TMDB_API_KEY}&append_to_response=translations`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

async function getTmdbMetadata(tmdbId, mediaType) {
  const primaryType = mediaType === "tv" ? "tv" : "movie";
  const fallbackType = primaryType === "tv" ? "movie" : "tv";
  const data = await fetchTmdbType(tmdbId, primaryType) ?? await fetchTmdbType(tmdbId, fallbackType);

  if (!data) return null;

  const title = data.name || data.title || "Unknown";
  const roEntry = data.translations?.translations?.find(t => t.iso_639_1 === "ro");
  const titleRo = roEntry?.data?.name || roEntry?.data?.title || title;

  return {
    title,
    originalTitle: data.original_name || data.original_title || null,
    titleRo,
  };
}

function normalizeTitle(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function wordTokenSet(str) {
  return new Set(
    String(str ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1),
  );
}

function jaccardScore(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  setA.forEach(t => { if (setB.has(t)) overlap++; });
  return overlap / (setA.size + setB.size - overlap);
}

function scoreTitleMatch(candidate, target) {
  if (normalizeTitle(candidate) === normalizeTitle(target)) return 1;
  return jaccardScore(wordTokenSet(candidate), wordTokenSet(target));
}

function selectBestCandidate(candidates, targetTitle) {
  let best = null;
  let bestScore = 0.3;

  for (const c of candidates) {
    const score = scoreTitleMatch(c.title, targetTitle);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best;
}

async function searchAnime(keyword) {
  const data = await apiRequest(`/search?keyword=${encodeURIComponent(keyword)}`);
  if (!data?.success) return [];

  return (data.results?.data ?? [])
    .filter(item => item?.id && item?.title)
    .map(item => ({ id: item.id, title: item.title }));
}

async function fetchEpisodeList(entryId) {
  const data = await apiRequest(`/episodes/${encodeURIComponent(entryId)}`);
  const episodes = data?.results?.episodes ?? [];
  return { episodes };
}

async function fetchServers(episodeId, episodeNo) {
  const data = await apiRequest(
    `/servers/${encodeURIComponent(episodeId)}?ep=${encodeURIComponent(episodeNo)}`,
  );
  return (data?.results ?? []).filter(s => s?.serverName && s?.type);
}

async function fetchStreamMeta(episodeId, episodeNo, serverName, type) {
  const qs = new URLSearchParams({
    id: `${episodeId}?ep=${episodeNo}`,
    server: serverName,
    type,
  }).toString();

  const data = await apiRequest(`/stream?${qs}`);
  return data?.results ?? null;
}

function buildCleanCdnUrl(sourceUrl) {
  try {
    const match = sourceUrl.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/[^/]+$/i);
    return match ? `${CDN_BASE}${match[1]}/${match[2]}/master.m3u8` : null;
  } catch {
    return null;
  }
}

async function verifyHlsPlayable(url) {
  try {
    const res = await fetch(url, {
      headers: { ...ORIGIN_HEADERS, "Range": "bytes=0-6" },
    });
    if (!res.ok && res.status !== 206) return false;
    const text = await res.text();
    return text.startsWith("#EXTM3U");
  } catch {
    return false;
  }
}

async function extractMegaStream(embedUrl) {
  try {
    const html = await httpGet(embedUrl, {
      "User-Agent": USER_AGENT,
      "Referer": "https://www.enma.lol/",
      "Accept": "text/html,application/json,text/plain,*/*",
    });
    if (!html) return null;

    const idMatch = html.match(/id="megaplay-player"[^>]*data-id="(\d+)"/)
      ?? html.match(/data-id="(\d+)"[^>]*data-realid=/);
    if (!idMatch) return null;

    const dataId = idMatch[1];
    const origin = new URL(embedUrl).origin;

    const jsonText = await httpGet(
      `${origin}/stream/getSourcesNew?id=${dataId}`,
      {
        "User-Agent": USER_AGENT,
        "Referer": embedUrl,
        "Origin": origin,
        "X-Requested-With": "XMLHttpRequest",
      },
    );
    if (!jsonText) return null;

    const data = JSON.parse(jsonText);
    const src = data.sources;

    let streamUrl = null;

    if (src && !Array.isArray(src) && typeof src === "object") {
      streamUrl = src.file || src.url;
    } else if (Array.isArray(src) && src[0]) {
      streamUrl = src[0].file || src[0].url;
    }

    if (!streamUrl) return null;

    const subtitles = (Array.isArray(data.tracks) ? data.tracks : [])
      .filter(t => t?.file)
      .map(t => ({
        url: t.file,
        lang: t.label || "Unknown",
        language: t.label || "Unknown",
        name: t.label || "Unknown",
      }));

    const candidates = [buildCleanCdnUrl(streamUrl), streamUrl].filter(Boolean);
    const checks = await Promise.all(candidates.map(url => verifyHlsPlayable(url)));
    const best = candidates.find((_, i) => checks[i]);

    return { url: best ?? streamUrl, subtitles };
  } catch {
    return null;
  }
}

function buildStreamResult({ url, subtitles, type }) {
  const isDub = type?.toLowerCase() === "dub";
  const name = isDub ? `${PROVIDER_NAME} \u2022 English` : `${PROVIDER_NAME} \u2022 Japanese [Sub]`;
  return {
    name,
    title: name,
    url,
    quality: "1080p",
    headers: ORIGIN_HEADERS,
    behaviorHints: { proxyHeaders: { request: ORIGIN_HEADERS } },
    subtitles,
  };
}

async function resolveServerStream(server, episodeId, episodeNo) {
  try {
    const streamMeta = await fetchStreamMeta(episodeId, episodeNo, server.serverName, server.type);
    const iframeUrl = streamMeta?.streamingLink?.iframe;
    if (!iframeUrl) return null;

    const resolved = await extractMegaStream(iframeUrl);
    if (!resolved?.url) return null;

    return buildStreamResult({
      url: resolved.url,
      subtitles: resolved.subtitles ?? [],
      type: server.type,
    });
  } catch {
    return null;
  }
}

async function gatherCandidates(tmdbData) {
  const titles = [...new Set(
    [tmdbData.title, tmdbData.originalTitle, tmdbData.titleRo].filter(Boolean),
  )];

  const queries = titles
    .map(t => t.replace(/[:\-–—]/g, " ").trim().slice(0, 60))
    .filter(Boolean);

  const resultSets = await Promise.all(queries.map(q => searchAnime(q)));

  const seen = new Map();
  for (const results of resultSets) {
    for (const r of results) {
      const prev = seen.get(r.id);
      if (!prev || r.title?.length < prev.title?.length) seen.set(r.id, r);
    }
  }

  return [...seen.values()];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType === "tv" && (season == null || episode == null)) return [];

    const tmdbData = await getTmdbMetadata(tmdbId, mediaType);
    if (!tmdbData) return [];

    const isTv = mediaType === "tv";
    const candidates = await gatherCandidates(tmdbData);
    if (!candidates.length) return [];

    const entry = selectBestCandidate(candidates, tmdbData.title) ?? candidates[0];
    if (!entry) return [];

    const { episodes } = await fetchEpisodeList(entry.id);
    const targetEpNo = isTv ? episode : (episodes[0]?.episode_no ?? 1);
    const ep = episodes.find(e => String(e.episode_no) === String(targetEpNo));
    if (!ep) return [];

    const episodeId = ep.id ?? `${entry.id}?ep=${ep.episode_no}`;
    const allServers = await fetchServers(episodeId, ep.episode_no);

    const hd1Servers = [...new Map(
      allServers
        .filter(s => s?.serverName?.toUpperCase() === "HD-1")
        .map(s => [`${s.type}:${s.serverName}`, s]),
    ).values()];

    if (!hd1Servers.length) return [];

    const settled = await Promise.allSettled(
      hd1Servers.map(s => resolveServerStream(s, episodeId, ep.episode_no)),
    );

    const seen = new Set();
    return settled
      .filter(r => r.status === "fulfilled" && r.value?.url)
      .map(r => r.value)
      .filter(s => !seen.has(s.url) && seen.add(s.url));
  } catch {
    return [];
  }
}

module.exports = { getStreams };